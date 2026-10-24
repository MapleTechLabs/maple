/**
 * The audit Workflow's heavy half, loaded on a run's first replay rather than at Worker startup:
 * the engine, the agent runtime and the backend services stay off the init's CPU budget.
 */
import { DatabasePgLive } from "@maple/backend/platform/DatabasePgLive"
import { Env } from "@maple/backend/platform/Env"
import { envPorts } from "@maple/backend/platform/env-ports"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import { layerMapleDbConnection } from "@maple/backend/platform/pg-connection-source"
import { SandboxClient } from "@maple/backend/sandbox/client"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { CloudflareRepoSandboxLive } from "@maple/backend/services/sandbox/CloudflareRepoSandbox"
import { RepoSandboxService } from "@maple/backend/services/sandbox/RepoSandboxService"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import type { SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import { eventTelemetry } from "@maple/infra/worker-telemetry"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { runSecurityAuditWorkflow } from "./workflow.run"

// Its own service name: hour-long background runs would skew maple-ai's request percentiles.
const auditTelemetry = eventTelemetry({ serviceName: "maple-security-audit" })

/** The run's services over the host Worker's env: database, store, and the repository sandbox. */
const runServices = (env: Record<string, unknown>) => {
	const base = Layer.mergeAll(DatabasePgLive, Env.layer, FetchHttpClient.layer).pipe(
		Layer.provideMerge(Layer.mergeAll(layerMapleDbConnection(env), envPorts(env))),
	)
	const sandbox = RepoSandboxService.layer.pipe(
		Layer.provide(CloudflareRepoSandboxLive),
		Layer.provide(Layer.mergeAll(VcsSourceService.layer, SandboxClient.layer)),
	)
	return Layer.mergeAll(SecurityAuditStore.layer, sandbox).pipe(Layer.provideMerge(base))
}

export const runHostedAudit = (payload: SecurityAuditWorkflowPayload, env: Record<string, unknown>) =>
	withPgConnectionScope(runSecurityAuditWorkflow(payload)).pipe(
		// The Workflow run is the entry point these layers belong to.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(Layer.mergeAll(runServices(env), auditTelemetry)),
	)
