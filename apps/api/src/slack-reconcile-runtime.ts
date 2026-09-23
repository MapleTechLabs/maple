import { eventTelemetry } from "@maple/infra/worker-telemetry"
import { Effect, Layer } from "effect"
import { EventBaseLive } from "@maple/backend/platform/DatabasePgLive"

import { SlackIntegrationService } from "@maple/backend/services/integrations/SlackIntegrationService"

// Catches workspaces that removed the app (or revoked its tokens) from Slack's
// own "Manage Apps" UI rather than Maple's dashboard: probes each active
// install and revokes locally any Slack confirms are dead.

/**
 * Deliberately not `maple-api`: background work sharing the request-facing
 * service's name skewed its percentiles (p99 32s, 2026-09-04). Provided by the
 * Worker around the fire; the layer below carries no tracer of its own.
 */
export const slackReconcileTelemetry = eventTelemetry({ serviceName: "maple-slack-reconcile" })

export const SlackReconcileLive = SlackIntegrationService.layer.pipe(Layer.provide(EventBaseLive))

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
