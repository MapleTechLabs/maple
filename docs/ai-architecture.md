# AI ownership

Maple has two AI capabilities: **Ask Maple**, a conversational assistant, and **Investigate**,
which produces a diagnostic report. Automatic investigations trigger Investigate. Alert assistance,
dashboard editing and widget repair are assistant tasks. Customer Agent Sessions are observability
data about customers' AI applications, separate from Maple's execution service.

## Service boundary

`apps/ai` is a private Cloudflare Worker. `apps/api` calls it through the `MAPLE_AI` service binding.
It has no public route, application database, broad reverse binding to the API, or product state.

| Owner                         | Responsibilities                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `apps/ai/src/assistant/`      | Assistant prompts, contextual tasks and delegated research                             |
| `apps/ai/src/investigations/` | Planning, hypothesis execution, validation, report completion and quality evals        |
| `apps/ai/src/runtime/`        | Agent engine configuration, budgets, delegation, tool adapters and usage accounting    |
| `apps/ai/src/platform/Llm.ts` | Provider clients, credentials, model selection and provider configuration              |
| `apps/api/src/chat/`          | Authenticated turn ownership, durable history, replay, cancellation and billing        |
| `apps/api/src/workflows/`     | Durable investigation steps, retries, fencing, persistence and transcript seeding      |
| `apps/api/src/mcp/`           | Tool catalog, parameter validation, tenant authorization and product operations        |
| `packages/domain/src/ai-*`    | RPC contracts, permission policy and pure investigation policy shared by both services |

Planner, hypothesis tester, validator and researcher are internal roles. They are not separate
products or global registry entries. Agent definitions name their permitted child definitions directly.
Neither application imports the other's implementation. The API has no agent-engine or model-provider
dependencies. Architecture tests enforce this boundary.

## Calls and capabilities

The private RPC contract has four methods: `chat`, `plan`, `hypothesis`, and `validate`. Inputs are
validated with Effect Schema; reports, plans and candidates are encoded before crossing RPC so
Schema.Class instances never escape into Cloudflare serialization or the workflow step cache.

For each run, the API supplies tool descriptors and a callback that is fixed to the authenticated
tenant and calling surface. The AI service cannot choose another tenant. The API independently
rejects mutating tool calls; proposed assistant actions still use the existing approval/apply route.
Callbacks retain the original API invocation context, including its database scope and tracing.

Chat receives two additional callbacks: publish events and submit a report for the session's fixed
investigation. Events are batched (up to 32 engine events or 20 ms) and published with backpressure.
The callback checks the current turn before writing. Releasing the turn revokes further tool calls;
the AI stream stops when publication reports the turn is no longer active. Usage snapshots accompany
publication and are flushed on completion or failure, for the API's existing billing finalizer.

The AI service owns no durable state. Existing ChatSession Durable Objects, Workflow identities,
step names, cached results, issue records and session prefixes stay on the API. A failed service
call follows the existing chat error path or investigation fallback/retry path. There is no local
model-execution fallback in the API.

## Development and deployment

`bun dev api` automatically includes the AI Worker. The root Alchemy stack creates it before the API
and supplies the service binding on every stage. CI installs, typechecks and tests the new workspace.
`apps/ai/src/worker.ts` disables workers.dev; local routing is available through the dev stack.

Provider configuration now belongs to the AI Worker: `OPENROUTER_API_KEY`, `MAPLE_LLM_PROVIDER`,
`MAPLE_TRIAGE_MODEL_*`, `MAPLE_LENS_MODEL_*`, and both reasoning-effort variables. Its `AI` binding
uses its own AI Gateway. Product/database credentials remain on the API. Telemetry uses `maple-ai`,
with the existing session/turn correlation attributes on model calls.

This extraction is wired for deployment but has not been deployed. Verify a real streamed chat,
a canceled turn, and an automatic investigation on staging before a production rollout. No data
migration is required. As before, a deployment can interrupt an in-flight model call; workflow
retries and the chat error path handle that outcome.

## Verification

```sh
bun run --cwd apps/ai test
bun run --cwd apps/ai typecheck
bun run --cwd apps/ai typecheck:test
bun run --cwd apps/api test src/ai src/chat src/workflows/InvestigationFanoutWorkflow.run.test.ts
```

`service.rpc.test.ts` bundles the real AI service and runs it in workerd alongside a caller Worker.
A local model response fixture exercises the default OpenRouter provider parser, actual RPC tool
callbacks, event streaming, metering, and serializable planner/validator results without credentials.
Provider-shim tests cover Workers AI separately. The existing engine limitation remains: delegated
child usage is not included in the parent billing total (`runtime/delegation.ts`).

An exploratory Workers AI end-to-end check exposed an existing provider limitation: its tool-result
decoder rejects the raw JSON Schema used by dynamic MCP tools. The extraction preserves that
adapter; Workers AI is not covered by the successful full-run RPC check. OpenRouter remains the
default provider. Fixing the upstream decoder or changing tool-schema construction needs its own
provider compatibility verification.
