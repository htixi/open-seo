# Restricted backlink automation

The Worker route `POST /api/automation/backlink-research` is disabled until
`BACKLINK_AUTOMATION_CLIENT_ID` is set. It is only available in
`AUTH_MODE=cloudflare_access` with D1. It verifies Cloudflare Access's signed
application JWT, pins the service-token Client ID, and accepts exactly
`{"target":"zety.com"}`. The server fixes the project to the verified
`cvgenerator.io` project and calls one cached Backlinks profile page. It does
not invoke MCP or accept a project ID, tool name, or arbitrary URL.

## Security setup

1. In the existing Cloudflare Zero Trust account, create one service token
   named `n8n OpenSEO CVGenerator backlink research`. Keep its Client Secret
   only in n8n's credential store.
2. Add that token to a **Service Auth** policy for the existing OpenSEO Access
   application only. Retain its existing user policies and protection. Do not
   add a Bypass rule. Confirm this policy covers the Worker URL used below.
3. Set `BACKLINK_AUTOMATION_CLIENT_ID` on the existing `open-seo` Worker to
   the token's Client ID. A Worker secret is suitable. This ID is the sole
   machine identity accepted by the route. Do not set its Client Secret on the
   Worker. Existing `TEAM_DOMAIN` and `POLICY_AUD` must identify the same
   OpenSEO Access application.
4. Create a dedicated n8n HTTP credential holding
   `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Put neither value in
   workflow JSON, node parameters, logs, or repository files.

The app verifies Access's `Cf-Access-Jwt-Assertion` signature, issuer,
audience, token type, empty subject, and pinned service-token Client ID.
Headers alone are not treated as proof of identity.

## Budget and operation

Each accepted request gets one 50-row page of `zety.com` and its subdomains'
referring pages,
with at most 10 rows returned. Before the paid call, the route reads the free
DataForSEO `appendix/user_data` price table and balance. Missing price,
balance, D1, project, or Access configuration fails closed. D1 atomically
reserves one request per UTC day, two per UTC week, eight per UTC month,
$0.05/day, and $0.25/month. The provider price estimate includes the request
and 50 result rows with 25% headroom. The route records the actual task cost
when DataForSEO returns it. A cache hit reports no provider request. A failed
call without a cost envelope records unknown actual cost.

The n8n schedule must run at most twice a week and must not retry paid calls.
Qualification, source-domain deduplication, persistence, and approval
notification belong in n8n. Outreach stays manual.

## Checks before enabling the schedule

- A request without the service credential is rejected by Access or the route.
- A request with another Access identity receives 401.
- `projectId`, `tool`, and non-allowlisted targets receive 403.
- The same-day second request receives 429, including if the first call failed.
- A successful call returns source and target URLs plus actual usage metadata.
- Existing `/mcp` remains operational.

The route reserves budget before a provider call. A failed call consumes its
request allowance to prevent unlimited retries. Do not use repeated live
requests to test the limit; the local SQLite test covers it without charges.

## Rollback

Remove `BACKLINK_AUTOMATION_CLIENT_ID` from the Worker to disable the route
immediately. Disable the n8n live schedule and revoke the dedicated Access
service token. Revert the Worker commit and redeploy through the repository's
existing GitHub Actions path if needed. The additive D1 tables can remain
unused; their removal is not required for rollback.
