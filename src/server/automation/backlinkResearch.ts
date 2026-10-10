import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { BacklinksService } from "@/server/features/backlinks/services/BacklinksService";
import { fetchUserData } from "@/server/lib/dataforseo/appendix";
import { validateTeamDomain } from "@/shared/selfhost-checks";

export const BACKLINK_AUTOMATION_PATH = "/api/automation/backlink-research";
const PROJECT_ID = "bb834131-b13d-42f0-84f2-2a3ca509e1d8";
const PROJECT_DOMAIN = "cvgenerator.io";
const TARGETS = new Set(["zety.com"]);
const PAGE_SIZE = 50;
const DAILY_REQUEST_LIMIT = 1;
const WEEKLY_REQUEST_LIMIT = 2;
const MONTHLY_REQUEST_LIMIT = 8;
const DAILY_USD_MICROS_LIMIT = 50_000;
const MONTHLY_USD_MICROS_LIMIT = 250_000;
const inputSchema = z.strictObject({ target: z.enum(["zety.com"]) });

type PriceEntry = { cost_type?: unknown; cost?: unknown };
type AccountPricing = {
  money?: { balance?: number | null } | null;
  price?: { backlinks?: { backlinks?: { live?: { priority_normal?: PriceEntry[] } } } };
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function verifyMachine(request: Request, env: Env): Promise<boolean> {
  const configured = env.BACKLINK_AUTOMATION_CLIENT_ID?.trim();
  const audience = env.POLICY_AUD?.trim();
  const team = env.TEAM_DOMAIN ? validateTeamDomain(env.TEAM_DOMAIN) : null;
  if (!configured || !audience || !team?.ok) return false;
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) return false;
  try {
    const keys = createRemoteJWKSet(new URL(`${team.origin}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(assertion, keys, {
      issuer: team.origin,
      audience,
    });
    return payload.type === "app" &&
      payload.sub === "" &&
      payload.common_name === configured &&
      typeof payload.email !== "string";
  } catch {
    return false;
  }
}

function providerWorstCase(account: AccountPricing): number | null {
  const entries = account.price?.backlinks?.backlinks?.live?.priority_normal;
  if (!Array.isArray(entries)) return null;
  const cost = (kind: string) => entries.find((entry) =>
    entry.cost_type === kind || entry.cost_type === kind.replace("_", "")
  )?.cost;
  const perRequest = cost("per_request");
  const perResult = cost("per_result");
  if (typeof perRequest !== "number" || !Number.isFinite(perRequest) || perRequest <= 0 ||
      typeof perResult !== "number" || !Number.isFinite(perResult) || perResult < 0) return null;
  // The account price table excludes add-on parameters. The fixed service call
  // uses no paid add-ons; reserve 25% headroom and reject price changes above
  // the configured daily hard cap.
  return Math.ceil((perRequest + PAGE_SIZE * perResult) * 1_000_000 * 1.25);
}

function periods(now: Date) {
  const day = now.toISOString().slice(0, 10);
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return { day, week: monday.toISOString().slice(0, 10), month: day.slice(0, 7) };
}

export async function reserve(db: D1Database, worstMicros: number, now: Date): Promise<boolean> {
  const { day, week, month } = periods(now);
  await db.prepare("INSERT OR IGNORE INTO backlink_automation_budget (project_id) VALUES (?)")
    .bind(PROJECT_ID).run();
  const row = await db.prepare(`
    UPDATE backlink_automation_budget SET
      day_key = ?, day_requests = CASE WHEN day_key = ? THEN day_requests + 1 ELSE 1 END,
      day_reserved_micros = CASE WHEN day_key = ? THEN day_reserved_micros + ? ELSE ? END,
      week_key = ?, week_requests = CASE WHEN week_key = ? THEN week_requests + 1 ELSE 1 END,
      month_key = ?, month_requests = CASE WHEN month_key = ? THEN month_requests + 1 ELSE 1 END,
      month_reserved_micros = CASE WHEN month_key = ? THEN month_reserved_micros + ? ELSE ? END
    WHERE project_id = ?
      AND (day_key <> ? OR day_requests < ?)
      AND (week_key <> ? OR week_requests < ?)
      AND (month_key <> ? OR month_requests < ?)
      AND (day_key <> ? OR day_reserved_micros + ? <= ?)
      AND (month_key <> ? OR month_reserved_micros + ? <= ?)
    RETURNING project_id`).bind(
      day, day, day, worstMicros, worstMicros,
      week, week,
      month, month, month, worstMicros, worstMicros,
      PROJECT_ID,
      day, DAILY_REQUEST_LIMIT,
      week, WEEKLY_REQUEST_LIMIT,
      month, MONTHLY_REQUEST_LIMIT,
      day, worstMicros, DAILY_USD_MICROS_LIMIT,
      month, worstMicros, MONTHLY_USD_MICROS_LIMIT,
    ).first();
  return row !== null;
}

async function recordRun(
  db: D1Database,
  runId: string,
  status: "success" | "error",
  actualCostUsd: number | null,
  error: string | null,
): Promise<void> {
  await db.prepare(`UPDATE backlink_automation_runs
    SET status = ?, actual_cost_usd = ?, error_code = ?, finished_at = ?
    WHERE id = ?`).bind(status, actualCostUsd, error, new Date().toISOString(), runId).run();
}

export async function handleBacklinkAutomation(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (env.AUTH_MODE !== "cloudflare_access" || env.DATABASE_PROVIDER === "postgres" || !env.DB ||
      !env.BACKLINK_AUTOMATION_CLIENT_ID) return json(503, { error: "automation_not_configured" });
  if (!(await verifyMachine(request, env))) return json(401, { error: "unauthorized" });
  const reader = request.body?.getReader();
  if (!reader) return json(400, { error: "invalid_json" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 256) {
      await reader.cancel();
      return json(413, { error: "request_too_large" });
    }
    chunks.push(value);
  }
  const rawBody = new TextDecoder().decode(
    Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
  );
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return json(400, { error: "invalid_json" }); }
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success || !TARGETS.has(parsed.data.target)) return json(403, { error: "target_not_allowed" });

  const project = await ProjectService.getProjectWithOrganization(PROJECT_ID);
  if (!project || project.project.domain !== PROJECT_DOMAIN) return json(503, { error: "project_scope_unavailable" });

  let account: AccountPricing;
  try { account = (await fetchUserData()) ?? {}; } catch { return json(503, { error: "pricing_unavailable" }); }
  const worstMicros = providerWorstCase(account);
  if (worstMicros === null || worstMicros > DAILY_USD_MICROS_LIMIT ||
      typeof account.money?.balance !== "number" || account.money.balance * 1_000_000 < worstMicros)
    return json(503, { error: "allowance_unverified" });

  const now = new Date();
  if (!(await reserve(env.DB, worstMicros, now))) return json(429, { error: "research_limit_reached" });
  const runId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO backlink_automation_runs
    (id, project_id, target, status, reserved_micros, started_at)
    VALUES (?, ?, ?, 'running', ?, ?)`).bind(runId, PROJECT_ID, parsed.data.target,
      worstMicros, now.toISOString()).run();

  let billed: number | null = null;
  try {
    const result = await BacklinksService.profileBacklinksPage({
      target: parsed.data.target,
      scope: "subdomains",
      page: 1,
      pageSize: PAGE_SIZE,
      sortField: "rank",
      sortOrder: "desc",
      filters: {},
      mode: "one_per_domain",
    }, {
      organizationId: project.organizationId,
      userId: "backlink-automation",
      userEmail: "automation@local.invalid",
      projectId: PROJECT_ID,
    }, { hideSpam: true }, (cost) => { billed = cost.costUsd; });
    const maxResults = Math.min(10, Math.max(1, Number(env.BACKLINK_AUTOMATION_MAX_RESULTS) || 10));
    const rows = result.rows.filter((row) => row.urlFrom && row.urlTo &&
      isWebUrl(row.urlFrom) && isWebUrl(row.urlTo) &&
      row.itemType === "anchor" && !row.relAttributes.includes("sponsored") &&
      !row.isLost && !row.isBroken && (row.spamScore === null || row.spamScore < 30))
      .slice(0, maxResults)
      .map((row) => ({ source_url: row.urlFrom, target_url: row.urlTo,
        anchor: row.anchor, domain_rank: row.domainFromRank, spam_score: row.spamScore,
        dofollow: row.isDofollow }));
    const actualCostUsd = billed ?? 0; // No provider call means the existing service cache served the page.
    await recordRun(env.DB, runId, "success", actualCostUsd, null);
    return json(200, { project: PROJECT_DOMAIN, target: parsed.data.target, rows,
      usage: { run_id: runId, provider_requests: billed === null ? 0 : 1,
        actual_cost_usd: actualCostUsd, reserved_usd: worstMicros / 1_000_000,
        from_cache: billed === null } });
  } catch (error) {
    await recordRun(env.DB, runId, "error", billed, error instanceof Error ? error.name : "unknown");
    return json(502, { error: "research_failed", run_id: runId,
      actual_cost_usd: billed });
  }
}
