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
