import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
  getProject: vi.fn(),
  fetchUserData: vi.fn(),
  profileBacklinksPage: vi.fn(),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => "test-keys"),
  jwtVerify: mocks.jwtVerify,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectWithOrganization: mocks.getProject },
}));
vi.mock("@/server/features/backlinks/services/BacklinksService", () => ({
  BacklinksService: { profileBacklinksPage: mocks.profileBacklinksPage },
}));
vi.mock("@/server/lib/dataforseo/appendix", () => ({ fetchUserData: mocks.fetchUserData }));

import { handleBacklinkAutomation, reserve } from "./backlinkResearch";

function database(allowed = true) {
  const queries: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      queries.push(sql);
      return {
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({})),
          first: vi.fn(async () => allowed ? { project_id: "test" } : null),
        })),
      };
    }),
  };
  return { db: db as unknown as D1Database, queries };
}

function environment(db: D1Database): Env {
  return {
    AUTH_MODE: "cloudflare_access",
    TEAM_DOMAIN: "https://test.cloudflareaccess.com",
    POLICY_AUD: "test-audience",
    BACKLINK_AUTOMATION_CLIENT_ID: "machine.access",
    DB: db,
  } as Env;
}

function request(body: unknown, withJwt = true): Request {
  return new Request("https://open-seo.test/api/automation/backlink-research", {
    method: "POST",
    headers: withJwt ? { "cf-access-jwt-assertion": "signed-access-jwt" } : {},
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.jwtVerify.mockResolvedValue({ payload: {
    type: "app", sub: "", common_name: "machine.access",
  } });
  mocks.getProject.mockResolvedValue({
    organizationId: "organization-1",
    project: { domain: "cvgenerator.io" },
  });
  mocks.fetchUserData.mockResolvedValue({
    money: { balance: 1 },
    price: { backlinks: { backlinks: { live: { priority_normal: [
      { cost_type: "per_request", cost: 0.02 },
      { cost_type: "per_result", cost: 0.00003 },
    ] } } } },
  });
  mocks.profileBacklinksPage.mockResolvedValue({ rows: [] });
});

describe("restricted backlink automation", () => {
  it("enforces daily and weekly quotas with the generated SQLite migration", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(readFileSync("drizzle/0047_bouncy_redwing.sql", "utf8")
        .replaceAll("--> statement-breakpoint", ""));
      const db = {
        prepare: (sql: string) => ({
          bind: (...args: Array<string | number>) => ({
            run: async () => sqlite.prepare(sql).run(...args),
            first: async () => sqlite.prepare(sql).get(...args) ?? null,
          }),
        }),
      } as unknown as D1Database;
      expect(await reserve(db, 27_000, new Date("2026-10-12T09:00:00Z"))).toBe(true);
      expect(await reserve(db, 27_000, new Date("2026-10-12T10:00:00Z"))).toBe(false);
      expect(await reserve(db, 27_000, new Date("2026-10-13T09:00:00Z"))).toBe(true);
      expect(await reserve(db, 27_000, new Date("2026-10-14T09:00:00Z"))).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("rejects missing or wrong machine identity before database and provider access", async () => {
    const { db, queries } = database();
    expect((await handleBacklinkAutomation(request({ target: "zety.com" }, false), environment(db))).status).toBe(401);
    mocks.jwtVerify.mockResolvedValueOnce({ payload: {
      type: "app", sub: "", common_name: "another-machine.access",
    } });
    expect((await handleBacklinkAutomation(request({ target: "zety.com" }), environment(db))).status).toBe(401);
    expect(queries).toHaveLength(0);
    expect(mocks.profileBacklinksPage).not.toHaveBeenCalled();
  });

  it("rejects extra project/tool fields and unallowlisted targets", async () => {
    const { db } = database();
    for (const body of [
      { target: "other.com" },
      { target: "zety.com", projectId: "another-project" },
      { target: "zety.com", tool: "delete_project" },
    ]) {
      expect((await handleBacklinkAutomation(request(body), environment(db))).status).toBe(403);
    }
    expect(mocks.profileBacklinksPage).not.toHaveBeenCalled();
  });

  it("fails closed on wrong project and unverified pricing", async () => {
    const { db } = database();
    mocks.getProject.mockResolvedValueOnce({ organizationId: "org", project: { domain: "wrong.com" } });
    expect((await handleBacklinkAutomation(request({ target: "zety.com" }), environment(db))).status).toBe(503);
    mocks.fetchUserData.mockResolvedValueOnce({ money: { balance: 1 } });
    expect((await handleBacklinkAutomation(request({ target: "zety.com" }), environment(db))).status).toBe(503);
    expect(mocks.profileBacklinksPage).not.toHaveBeenCalled();
  });

  it("rejects an exhausted atomic budget before research", async () => {
    const { db } = database(false);
    expect((await handleBacklinkAutomation(request({ target: "zety.com" }), environment(db))).status).toBe(429);
    expect(mocks.profileBacklinksPage).not.toHaveBeenCalled();
  });

  it("returns only bounded research fields and records usage", async () => {
    const { db, queries } = database();
    mocks.profileBacklinksPage.mockImplementationOnce(async (
      _input: unknown, _customer: unknown, _options: unknown,
      onBilling: (cost: { costUsd: number }) => void,
    ) => {
      onBilling({ costUsd: 0.0215 });
      return { rows: [{
        urlFrom: "https://example.org/cv-guide",
        urlTo: "https://zety.com/cv",
        anchor: "create a CV", domainFromRank: 45,
        spamScore: 5, isDofollow: true, isLost: false, isBroken: false,
        itemType: "anchor", relAttributes: [],
        internalSecret: "must-not-leak",
      }] };
    });
    const response = await handleBacklinkAutomation(request({ target: "zety.com" }), environment(db));
    const result = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].internalSecret).toBeUndefined();
    expect(result.usage.actual_cost_usd).toBe(0.0215);
    expect(result.usage.provider_requests).toBe(1);
    expect(queries.some((sql) => sql.includes("UPDATE backlink_automation_budget"))).toBe(true);
    expect(queries.some((sql) => sql.includes("UPDATE backlink_automation_runs"))).toBe(true);
  });
});
