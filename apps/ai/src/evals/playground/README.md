# Tool playground: agents testing tools by using them

The model-driven evals in `src/evals/` grade which tool a model picks for one request. This
playground answers a different question: given a realistic task and only Maple's tools, how
efficiently does an agent get to the right answer, and where do the tools slow it down?

An agent (a Claude Code subagent, or any agent with a shell) plays the Maple agent. It may only
call tools through `scripts/tool-playground.sh`, which runs the real registry, decoding and
rendering against a fixture warehouse, and prints exactly what a model would read:

```sh
cd apps/ai
scripts/tool-playground.sh catalog                       # every public tool, as a model sees it
scripts/tool-playground.sh schema inspect_infra           # one tool's input schema
PLAYGROUND_LOG=/tmp/run.jsonl scripts/tool-playground.sh call list_infra '{"kind":"pods"}'
```

Each call is one vitest run (about 5s) on a fresh database, so writes do not persist between
calls: a dashboard created in one call cannot be read back in the next. Tell agents that in a
scenario that writes. The log records tool, arguments, outcome and size.

## The infra world

`src/mcp/__evals__/infra-world.ts`, one Kubernetes cluster (`prod-eu`) plus Docker hosts:

| Fact                                                                                                                                                             | Where                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `checkout-6f9c7d-k2x8p` (deployment `checkout`, ns `shop`, node `ip-10-0-3-57`) peaks at 98% of its memory limit 70% through the window, then drops: an OOM kill | pods, workloads, `diagnose_service checkout` |
| `otel-agent` daemonset pods run with no CPU or memory limits                                                                                                     | pods, workloads                              |
| `ip-10-0-3-57` is the busy node (3.62 cores in use, up 1 day) and hosts the OOM pod, `postgres-0`, an api-gateway pod and a cart pod                             | nodes                                        |
| `ci-runner-01` host: CPU 91%, disk 93%, load 7.8; its `buildkitd` container peaks at 97% CPU and restarted twice                                                 | hosts, containers                            |
| `bastion-01` host is idle                                                                                                                                        | hosts                                        |

Traces, logs and errors are empty in this world. A scenario that needs them is not ready.

## Scenarios

Each is written the way a user would ask, with no tool or parameter names. `Must find` is graded
against the final answer; `Efficient path` is the call count a well-designed tool set allows.

| #   | Ask                                                                             | Must find                                                                                   | Efficient path |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------- |
| 1   | Is anything in our infrastructure running hot right now?                        | OOM-risk checkout pod (98% memory), buildkitd at 97% CPU, ci-runner-01 disk 93%             | 1-2            |
| 2   | Checkout has been flaky for the last few hours. Could it be a resource problem? | checkout pod hit 98% of its memory limit, when it peaked, it is one of 3 pods               | 2-3            |
| 3   | Which of our pods have no resource limits?                                      | both otel-agent pods (daemonset, ns observability)                                          | 1              |
| 4   | What runs on node ip-10-0-3-57, and is it overloaded?                           | its pods incl. the checkout pod at its memory limit; node uses 3.62 cores                   | 1-2            |
| 5   | Our CI builds got slow. Can you check the CI machine?                           | ci-runner-01: CPU 91%, disk 93%, buildkitd at 97% CPU with 2 restarts                       | 2-3            |
| 6   | How has the postgres pod's memory looked over the last day?                     | postgres-0, about 72% of its limit, peak about 79%                                          | 1-2            |
| 7   | Build me a dashboard with CPU utilization per host.                             | create_dashboard on source=metrics, `system.cpu.utilization`, group by `resource.host.name` | 1-3            |
| 8   | How many 5xx errors did the API return today? (negative)                        | does not use the infra tools; traces/errors tools instead                                   | n/a            |

## The integration world

`src/mcp/__evals__/integration-world.ts` seeds Postgres with connected integrations and adds
warehouse rules for CI runs and deployed versions. It shares names with `provider-world.ts`
(zones, the `shop` Railway project, the PlanetScale databases). The playground tenant is an org
admin, so the admin-only integration tools run.

| Fact                                                                                                    | Where                                                |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `acme/api` stopped syncing: the GitHub App lost access                                                  | list_integrations, audit_setup                       |
| Cloudflare analytics for `status.example.com` fail on a missing Analytics:Read permission               | list_integrations, audit_setup                       |
| Railway `shop / preview` has had no successful poll for 4 h; production and staging are fresh           | list_integrations, audit_setup, sync_railway         |
| PlanetScale deploy-request sync for `maple-analytics` fails (HTTP 404); metrics flow                    | list_integrations, audit_setup                       |
| Scrape target `legacy-exporter` fails with connection refused                                           | list_integrations, audit_setup, update_scrape_target |
| `shop` CI has failed since `a1a1…` ("allow stacking two coupons"): job `test (small-6)`, `cart.test.ts` | ci_runs                                              |
| `checkout` (production) moved from `a0a0…` to `a3a3…`: three commits                                    | service_deployments, compare_commits                 |

### Integration scenarios

| #   | Ask                                                                                        | Must find                                                                        | Efficient path |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------- |
| I1  | What third-party stuff do we have hooked up, and is any of it broken?                      | all five problems above                                                          | 1              |
| I2  | Our Railway preview charts stopped updating. What's going on, and can you kick it?         | preview stale 4 h, others fresh; sync_railway                                    | 2              |
| I3  | CI on the shop repo has been red since yesterday. What broke, and which change started it? | test (small-6) fails on cart.test.ts since the coupon commit; last green at a0a0 | 1-2            |
| I4  | What shipped in the latest checkout deploy?                                                | the three commits between a0a0 and a3a3                                          | 1              |
| I5  | Can you look at the acme/api source to see how it calls the payments service?              | acme/api is not syncing (App lost access); grant access                          | 1-2            |
| I6  | The legacy-exporter target has been dead for a day. Pause it.                              | update_scrape_target enabled=false                                               | 1              |
| I7  | Is our api service healthy? It runs on Railway.                                            | Railway api in production at 99 % of its CPU limit                               | 1-2            |
| I8  | Start collecting metrics from https://metrics.acme.dev/node2 for billing.                  | create_scrape_target with service billing                                        | 1              |

### Integration results (Haiku; data calls, excluding `catalog`/`schema`)

| #   | Round 1                       | Round 2                                   | Round 3    | Round 4                | Notes                                                                                                                                                       |
| --- | ----------------------------- | ----------------------------------------- | ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | 2, correct                    | 2                                         | 2          |                        | fixed: overview shows unhealthy of total, two `next` calls instead of twelve                                                                                |
| I2  | wrong (fixture contradiction) | 8, correct                                | 5, correct |                        | sync_railway now says an environment is still stale after the poll and why                                                                                  |
| I3  |                               | 14, correct                               | failed     | 2 (+3 wasted), correct | ci_runs names the red streak, its first failing and last green commits, and hands full SHAs to compare_commits; `result` no longer hides the last green run |
| I4  |                               | 2, correct                                |            |                        |                                                                                                                                                             |
| I5  | blocked (fixture ids)         | blocked (no GitHub App in the playground) | correct    |                        | list_source_repositories flags repositories that stopped syncing                                                                                            |
| I6  |                               | 2, correct                                |            |                        | paused targets say so, with no "after the next scrape" hint                                                                                                 |
| I7  |                               | 4, correct                                |            |                        | diagnose_service says "no spans", not a healthy 0 %                                                                                                         |
| I8  |                               | 2, correct                                |            |                        |                                                                                                                                                             |

Open: `list_infra` with no rows does not say its default window is 1 hour, and its `environment`
filter does not say it takes the bare Railway environment name (`preview`, not `shop / preview`).
CI trace ids from the fixture do not resolve in `inspect_trace`: the world has no CI spans.

## The security world

`src/mcp/__evals__/security-world.ts` builds on the integration world (`acme/shop`, `acme/api`,
`checkout` deployed from `CI_WORLD.head`) and answers the Security Center's catalogs
(endoflife.date, OSV) with a stubbed `fetch`. Only the probe requests' spans exist as traces.

| Fact                                                                                                         | Where                                  |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Code audit of `acme/shop`: confirmed critical cross-tenant order export, confirmed high, an unconfirmed lead | list_security_findings, inspect        |
| `cart/coupon-replay` dismissed with a reason; `auth/jwt-none-alg` fixed; a rejected SSRF claim               | `status=all`, inspect                  |
| `acme/api`'s latest audit stopped at the spend limit; it has no dependency scan                              | area summaries                         |
| `next` 14.1.0 (CVE-2025-29927, critical, direct) runs in checkout production; `vitest` is dev only           | dependencies, inspect `CVE-2025-29927` |
| `legacy-admin` served `/.env`, `billing` served `/actuator/env`; `marketing-site` answers every path         | exposure, inspect `legacy-admin:/.env` |
| nuclei from 185.220.101.4 is the busiest scanner                                                             | `area=exposure`                        |
| checkout on Node.js 18.19.0 (EOL, CVE-2025-23166), api-gateway on 22.4.0 (critical CVE), legacy-admin on 3.8 | runtimes, inspect `CVE-2025-23166`     |
| `run-api-1` stopped at the $25 monthly limit: webhooks deferred, admin blocked, exports never reached        | list/inspect_security_audit_run        |
| `run-shop-1` reported 6 claims, the webhook SSRF rejected with the verifier's reason; it has a 3-entry log   | inspect_security_audit_run             |

### Security scenarios

| #   | Ask                                                                                      | Must find                                                                                                           | Efficient path |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------- |
| S1  | What are our biggest security problems right now?                                        | order export, next CVE in checkout, legacy-admin `/.env`, api-gateway Node CVE; acme/api gaps                       | 1-2            |
| S2  | I saw CVE-2025-29927 on Hacker News. Are we affected? Where, and what do we do?          | next 14.1.0 in acme/shop, checkout production, upgrade to 14.2.25; acme/api unknown                                 | 1              |
| S3  | Is anyone scanning or probing our services? Did they actually get anything?              | nuclei and two others; legacy-admin `/.env` and billing `/actuator/env` answered 200; marketing-site is a catch-all | 2-3            |
| S4  | Which of our services run outdated or end-of-life runtimes?                              | checkout Node 18 EOL, legacy-admin Python 3.8 EOL, api-gateway behind; cart and edge-worker not judged              | 1              |
| S5  | Explain the critical order export finding, how it is exploited and how to fix it.        | missing orgId filter at export.ts, the request, filter on the tenant's orgId                                        | 2              |
| S6  | What vulnerabilities affect the checkout service? Prioritize them.                       | order export, next, reset timing, avatar lead, Node 18, axios, cookie; not vitest                                   | 1-2            |
| S7  | Which findings did we dismiss or accept, and why? Is our coverage complete?              | coupon replay dismissed with its reason; acme/api never scanned and its audit incomplete                            | 2              |
| S9  | CVE-2025-23166 in Node.js is being exploited. Which services, and to what version?       | checkout to 18.20.6, api-gateway to 22.12.0; Python services clean; cart not checkable                              | 1              |
| S10 | Did we fix the JWT alg none problem? What high or critical issues are open in acme/shop? | fixed by the latest audit run; the open code and dependency findings of acme/shop                                   | 2              |
| R1  | Show me the audit runs for acme/shop and acme/api. Which is latest, did it finish?       | run-shop-1 complete; run-api-1 incomplete (spend limit); durations                                                  | 1              |
| R2  | For the last acme/api audit: what did it cover and skip? Why did it stop?                | 2 of 5 units covered; webhooks deferred, admin blocked, exports never reached; spend limit                          | 1              |
| R3  | How much have we spent on audits this month, and what is our limit?                      | over the $25 limit, resets on the 1st                                                                               | 1              |
| R4  | Which repositories are set up for the audit and the dependency scan, and when last run?  | both audited; acme/api never dependency-scanned                                                                     | 1              |
| R5  | Everything the last acme/shop audit reported, rejected claims and its log                | 6 claims, SSRF rejected with its reason; the run's log                                                              | 1              |
| R6  | Any vulnerable dependencies in acme/api? (never scanned)                                 | not scanned, so unknown; not "clear"                                                                                | 1              |

### Security results (Haiku unless noted; data calls, wasted in brackets)

| #   | Round 1 | Round 2 | Round 3 | Round 4    | What changed after the round                                                                                                                                          |
| --- | ------- | ------- | ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 3       |         |         | 2 (Sonnet) | coverage gaps moved from notes into area summaries; the window label names the areas it applies to                                                                    |
| S2  | 2 (+4)  |         |         | 2          | dependency rows say what to change; an advisory lookup leads with a verdict and leaves out the side (runtime or package) it is not on                                 |
| S3  | 2 (+9)  | 4 (+15) | 4 (+2)  | 5 (+1)     | answered probes became inspectable (`service:/path`, every probe the service got); scanners on ordinary pages no longer show 2xx counts; the world gained probe spans |
| S4  | 1       |         |         |            | unjudged runtimes (Bun posing as Node.js, Workers) are named in the summary                                                                                           |
| S5  |         | 2       |         |            |                                                                                                                                                                       |
| S6  |         | 8 (+3)  | 7 (+3)  |            | code findings carry the services that run their repository (from the dependency scanner's running commits), so `service` keeps them                                   |
| S7  |         | 6 (+2)  | 7 (+3)  |            | triage reasons show in the list; counts follow the filters; a repository filter skips the per-service areas                                                           |
| S9  |         |         | 2 (+1)  |            | an advisory lookup lists services checked clean and the ones it could not check                                                                                       |
| S10 |         |         |         | 4 (+1)     | fixed findings name the audit run and commit that stopped finding them                                                                                                |

Every answer was correct from round 1 on; the rounds cut wasted calls. Open items the agents still
raise: Maple sees a probe's status code, not the response body, so "did they get the file" stays a
manual check; a transitive dependency's parent package is not recorded; the catalog's size makes
grepping it the only practical discovery step in the playground (real clients list tools natively).

## The data source world

`src/mcp/__evals__/ds-world/` connects 18 external data sources through the real
`ExternalDataSourceService` (secrets encrypted, catalogs stored in PGlite). Agents see 17:
`people-ops` (HR, `hr.payroll`) has agent access off. Clerk sources run the real Clerk driver
against `makeFakeClerk` (real pagination, filters and totals), rebuilt relative to now on every
call. ClickHouse sources store catalogs built from the same table definitions that seed Docker,
and run their SQL through the real driver on two ClickHouse 26.2 servers (`main`, `staging`;
staging and dev copies reuse the `shop` and `billing` database names). Each source has its own
ClickHouse user granted SELECT on its database only.

```sh
cd apps/ai
scripts/data-source-world-ch.sh up      # start (or reuse) and reseed both servers, ~10 s
PLAYGROUND_CH=1 scripts/tool-playground.sh call query_data_source '{"data_source":"shop-prod","sql":"SELECT count() FROM shop.payments"}'
scripts/data-source-world-ch.sh down    # remove the containers
```

Without `PLAYGROUND_CH=1`, every catalog tool and Clerk works and SQL answers "refused the
connection". Rows are relative to the seeding time with no rows within 3 hours of the 1, 7 and
30 day marks, so the facts below hold for 3 hours after `up`; rerun `up` after that.
`src/mcp/__evals__/ds-world/world.test.ts` checks the world without Docker.

| Fact                                                                                                                                 | Where                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Invoices: `billing.invoices` in `billing` (production); `billing-dev` has a fake copy, `warehouse-legacy` a 2019 archive             | search `invoices` ranks billing first                  |
| Signups (Clerk `users.created_at`): 74 in the last 7 days, 315 in the last 30; 11 or 12 a weekday, 9 on two days a week              | clerk-prod; clerk-dev has 60 QA accounts               |
| `last_active_at` holds each user's latest activity only: no per-day active history in Clerk; `analytics.events` is anonymous         | clerk-prod, analytics                                  |
| Paid revenue last 7 days: $44,398.47 (US $10,598.13, GB $7,826.02, DE $7,428.36, CA $3,952.40, BR, FR, AU, JP about $3.5-3.7k)       | shop-prod: payments.amount in cents, customers.country |
| Failed payments in the last 24 h: 6 in shop-prod (55 paid, 2 refunded); shop-staging has 1                                           | shop.payments.status                                   |
| Active subscriptions: 714 of 1,000 in billing (billing-dev: 15 of 30)                                                                | billing.subscriptions.status                           |
| `iot.readings.ts` is UInt32 epoch seconds; `cold-room-2` warms from 4 to about 10 C over the last 3 days, every other device is flat | iot-metrics                                            |
| `warehouse-legacy` has 400 tables; 398 are leftovers (`etl_stage_*`, `bak_2019_*`, ...)                                              | describe pages of 100                                  |
| No agent-visible source holds payroll                                                                                                | people-ops is hidden                                   |

`shop.orders` mirrors payments (`completed` = paid), so completed order totals give the same
revenue. A calendar-week answer differs from the last 7 days and is correct when it says so.

### Data source scenarios

| #   | Ask                                                          | Must find                                                                                                        | Efficient path |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------- |
| D1  | Which database has our invoices?                             | billing (production), `billing.invoices`; billing-dev is fake, the legacy table is a 2019 archive                | 1-2            |
| D2  | How many people signed up this week?                         | clerk-prod (not dev), a count with its window stated: 74 for the last 7 days                                     | 2-3            |
| D3  | Chart daily signups for the last 30 days.                    | clerk-prod per-day counts (~315 total); says it cannot save a chart yet (dashboards on data sources are phase 2) | 2-3            |
| D4  | Show daily active users for the last month.                  | explains `last_active_at` holds only the latest activity; offers what is answerable; no fabricated series        | 2-3            |
| D5  | How much revenue did we make by country last week?           | shop-prod (not staging), cents divided by 100, paid only, per country                                            | 3-4            |
| D6  | How many payments failed in the last day?                    | 6, shop-prod                                                                                                     | 2-3            |
| D7  | How many active subscriptions do we have?                    | 714, billing, no time window                                                                                     | 2-3            |
| D8  | What's the temperature trend from our IoT sensors this week? | epoch `ts` handled; cold-room-2 rising to about 10 C while the rest are flat                                     | 3-4            |
| D9  | What was our total payroll last month?                       | no visible source has payroll; says so, does not guess                                                           | 1-2            |
| D10 | How many 5xx errors did the API return today? (negative)     | no data source tools; traces/errors tools                                                                        | n/a            |

### Data source results (Haiku, 2026-11-08; logged calls, wasted in brackets)

Every run picked the production source over staging and dev, and every first `query_data_source`
call used the right form (SQL vs resource) once the epoch fix landed.

| #   | Round 1                                   | Round 2                         | Round 3                       | What changed after the round                                                                          |
| --- | ----------------------------------------- | ------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | 2, correct                                |                                 |                               | before round 1, the world test caught the legacy archive outranking `billing.invoices`; fixed         |
| D2  | 4, correct (71 for the calendar week)     |                                 |                               |                                                                                                       |
| D3  | 4, correct (311), said no chart is saved  |                                 |                               | `query_data_source` states its 24 h default window                                                    |
| D4  | 5, wrong: never looked at data sources    | 10 (+6), correct                | 6 (+3), correct               | `list_users` and product events point to `search_data_sources`; Clerk users say DAU is not answerable |
| D5  | 4, correct ($44.4k calendar week, orders) |                                 |                               |                                                                                                       |
| D6  | 3, correct (6, prod)                      |                                 |                               |                                                                                                       |
| D7  | 3, correct (714)                          |                                 |                               | a SQL result with no window macro says the window was not applied                                     |
| D8  | 4 (+2), partial: no per-device split      | 3, form right, averaged devices | 5 (+1), partial (by location) | macro refusal, cheat sheet and the toStartOfInterval error explain epoch-seconds columns              |
| D9  | 7 (+4), correct, paged all 400 tables     | 3, correct                      |                               | an empty search says it already covers every visible catalog and that sources can be hidden           |
| D10 | 4, correct, no data source calls          |                                 |                               |                                                                                                       |

Open, not fixed here:

- D8 is analysis, not tool friction: Haiku averages all sensors (or groups by location) and misses
  the one failing device. A per-device breakdown hint would be scenario coaching, not a tool fix.
- D4 still tries Maple's own product events and `run_sql` first; the chat system prompt's
  per-source lines (plan section 3) are not in the playground, which only shows the tool catalog.
- Saving a widget or alert on a data source does not exist yet (phases 2 and 3), so D3 grades
  the query and an honest "cannot save it".
- Agents ask how many sources are hidden from them; by design the tools do not say.
- `describe_data_source` on a 400-table source pages 100 at a time with no name filter; search
  covers it, but an `entries` prefix filter would make browsing cheaper.

## Grading

Per scenario, from the agent's report and the JSONL log:

- **Correct**: every `Must find` fact is in the answer, nothing invented.
- **Calls**: total calls, and wasted calls (invalid input, an empty result the agent then had to
  widen, `run_sql` used where an infra tool fits, a call repeated with the same arguments).
- **Friction**: what the agent says confused it: a misleading description, a missing filter,
  a value it could not interpret (fraction or percent? of what limit?), a `next` hint that led
  nowhere.

A tool set is done when every scenario is correct on both a strong and a small model, within its
efficient path, with no friction note pointing at the tool rather than the task. Fix the tool
(description, parameters, rendering, `next` hints), never the scenario, and rerun the round.

## Running a round with subagents

Give each subagent one scenario and these rules verbatim (subagents do not inherit them):

1. You are an agent whose only tools are Maple's MCP tools. Call them only with
   `apps/ai/scripts/tool-playground.sh call <tool> '<json>'` (use `catalog` and `schema` first).
   Do not read the repository's source, tests or fixtures: you would be grading the code, not
   using the tools.
2. Run commands with a timeout of at most 150000 ms, one call at a time.
3. Answer the user's question, then report: every call you made and why, which calls were
   wasted, and what in the tools' descriptions or output confused you or was missing.

Set `PLAYGROUND_LOG` to a per-scenario file so the log can be graded alongside the report.
Run at most four subagents at once: each call starts a vitest process.

## Results so far (Haiku unless noted; data calls, excluding `catalog`/`schema`)

| #   | Round 1 | Round 2 | Round 3                       | Round 4    | Status                                                         |
| --- | ------- | ------- | ----------------------------- | ---------- | -------------------------------------------------------------- |
| 1   | 2       | 2       |                               | 1 (Sonnet) | done                                                           |
| 2   | 3       | 4       | 3                             | 3          | done; 2 is reachable (list_infra, then inspect_infra workload) |
| 3   | 1       |         | 1                             |            | done                                                           |
| 4   |         | 2       | 3                             | 4          | correct; call count varies on Haiku                            |
| 5   | 3       |         | 2                             |            | done                                                           |
| 6   |         | 2       | 2                             |            | done                                                           |
| 7   |         |         | 10, then 7 (broken dashboard) | 3          | done after the sandbox modeled metric discovery                |
| 8   |         |         | correct, no infra calls       |            | done                                                           |

Every answer was correct from round 2 on. The open items the agents still raise:

- Node capacity is not collected (`k8s.node.allocatable_cpu` from the k8s_cluster receiver would
  answer "is this node full?").
- Pod restarts have no termination reason; the OOM verdict is inferred from the memory curve.
- `create_dashboard` simple specs cannot filter `system.cpu.utilization` to non-idle states, so a
  "CPU per host" chart averages across states; units for `widgets` are not enumerated.
