import { eventTelemetry } from "@maple/infra/worker-telemetry"
import { Effect, Layer } from "effect"
import { EventBaseLive } from "@/platform/DatabasePgLive"
import { Env } from "@/platform/Env"
import { ApiKeysService } from "./services/org/ApiKeysService"
import { OAuthStateRepository } from "./services/auth/OAuthStateRepository"
import { SlackIntegrationService } from "./services/integrations/SlackIntegrationService"

// Slack workspace reconciliation's cron layer graph — mirrors
// vcs-sync-runtime.ts's `ScrapeRetentionLive`, its own light graph
// (NOT the fetch path's MainLive) so the tick stays within the startup CPU
// budget. `SlackIntegrationService` needs `ApiKeysService` (to revoke the
// minted bot key) and `OAuthStateRepository` (unused by this tick, but a
// dependency of `SlackIntegrationService.make` regardless) on top of
// Database + Env; its own `static readonly layer` already provides the
// FetchHttpClient it needs to call Slack's `auth.test`.
//
// Backstop for the Railway-hosted bot's app_uninstalled/tokens_revoked
// detection (apps/slack-agent → POST /internal/slack/workspaces/:teamId/revoke,
// see slack-integration.http.ts): catches a forward call the bot never made
// (crash mid-processing, network blip to Maple) and installs that predate
// this wiring.

/**
 * Deliberately not `maple-api`: background work sharing the request-facing
 * service's name skewed its percentiles (p99 32s, 2026-09-04). Provided by the
 * Worker around the fire; the layer below carries no tracer of its own.
 */
export const slackReconcileTelemetry = eventTelemetry({ serviceName: "maple-slack-reconcile" })

export const SlackReconcileLive = (() => {
	const Base = EventBaseLive

	const ApiKeysServiceLive = ApiKeysService.layer.pipe(Layer.provide(Base))
	const OAuthStateRepositoryLive = OAuthStateRepository.layer.pipe(Layer.provide(Base))
	const SlackIntegrationServiceLive = SlackIntegrationService.layer.pipe(
		Layer.provide(Layer.mergeAll(Base, ApiKeysServiceLive, OAuthStateRepositoryLive)),
	)

	return SlackIntegrationServiceLive
})()

/** The cron program: probe every active Slack workspace, revoke locally any Slack confirms are dead. */
export const runSlackReconciliation = Effect.gen(function* () {
	const slack = yield* SlackIntegrationService
	const result = yield* slack.reconcileWorkspaces()
	yield* Effect.logInfo("[Slack] reconciliation tick complete").pipe(
		Effect.annotateLogs({ probed: result.probed, revoked: result.revoked }),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks the tick as Error.
	Effect.tapCause((cause) =>
		Effect.logError("[Slack] reconciliation tick failed").pipe(
			Effect.annotateLogs({ error: String(cause) }),
		),
	),
	Effect.withSpan("SlackReconciliation.tick"),
)
