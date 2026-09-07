/**
 * The heavy modules the Worker reaches on the first event, never at module
 * scope. The static import graph behind the HTTP graph eagerly builds hundreds
 * of Effect Schema ASTs (`@maple/domain` + 47 MCP tool schemas) at
 * module-evaluation time. Cloudflare runs only the top-level module scope
 * during upload validation, so pulling that work in statically blew the fixed
 * ~1s startup CPU budget (error 10021). Behind `import()` the top level stays
 * near-empty; the cost moves to the first event, which runs under the far
 * larger per-request CPU budget. The Postgres scope module is deferred for the
 * same reason. `Effect.cached` these once per isolate at the use site.
 */
import { Effect } from "effect"

export const pgScopeModule = Effect.promise(() => import("../platform/pg-connection-scope"))
export const rpcModule = Effect.promise(() => import("../internal-rpc"))
export const vcsSyncModule = Effect.promise(() => import("../vcs-sync-runtime"))
export const planetScaleWebhookModule = Effect.promise(() => import("../planetscale-webhook-runtime"))
export const auditEventsModule = Effect.promise(() => import("../audit-events-runtime"))
export const slackReconcileModule = Effect.promise(() => import("../slack-reconcile-runtime"))
