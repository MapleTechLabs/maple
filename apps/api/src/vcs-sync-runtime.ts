import type { MessageBatch } from "@cloudflare/workers-types"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Cause, Effect, Layer, Option } from "effect"
import { DatabaseD1Live } from "./lib/DatabaseD1Live"
import { Env } from "./lib/Env"
import { GithubAppClient } from "./services/github/GithubAppClient"
import { GithubHttp } from "./services/github/GithubHttp"
import { GithubProvider } from "./services/github/GithubProvider"
import { VcsProviderRegistry } from "./services/vcs/VcsProviderRegistry"
import { VcsRepository } from "./services/vcs/VcsRepository"
import { VcsScheduledSyncService } from "./services/vcs/VcsScheduledSyncService"
import { clampQueueDelaySeconds, VcsSyncQueue } from "./services/vcs/VcsSyncQueue"
import { VcsSyncService } from "./services/vcs/VcsSyncService"

// ---------------------------------------------------------------------------
// Per-invocation runtime for the `VCS_SYNC_QUEUE` consumer. Mirrors the
// alerting worker's `buildLayer`: its own light layer graph (NOT the fetch
// path's MainLive) so the queue invocation stays within the startup CPU budget.
// ---------------------------------------------------------------------------

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
})

export const buildVcsSyncLayer = (_env: Record<string, unknown>) => {
	const ConfigLive = WorkerConfigProviderLayer
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))
	const DatabaseLive = DatabaseD1Live.pipe(Layer.provide(WorkerEnvironment.layer))
	const Base = Layer.mergeAll(EnvLive, DatabaseLive, WorkerEnvironment.layer)

	const VcsRepositoryLive = VcsRepository.layer.pipe(Layer.provide(Base))
	const GithubAppClientLive = GithubAppClient.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, GithubHttp.layer)),
	)
	const GithubProviderLive = GithubProvider.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, GithubAppClientLive)),
	)
	const VcsProviderRegistryLive = VcsProviderRegistry.layer.pipe(Layer.provide(GithubProviderLive))
	const VcsSyncQueueLive = VcsSyncQueue.layer.pipe(Layer.provide(WorkerEnvironment.layer))
	const VcsSyncServiceLive = VcsSyncService.layer.pipe(
		Layer.provide(Layer.mergeAll(VcsRepositoryLive, VcsProviderRegistryLive, VcsSyncQueueLive)),
	)

	return VcsSyncServiceLive.pipe(
		Layer.provideMerge(telemetry.layer),
		Layer.provideMerge(ConfigLive),
	)
}

// The periodic (cron) producer's layer graph. Deliberately lighter than the
// consumer's: enqueuing installation-sync jobs needs only storage + the queue —
// NOT the provider registry (the consumer does all provider work).
export const buildVcsScheduledLayer = (_env: Record<string, unknown>) => {
	const ConfigLive = WorkerConfigProviderLayer
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))
	const DatabaseLive = DatabaseD1Live.pipe(Layer.provide(WorkerEnvironment.layer))
	const Base = Layer.mergeAll(EnvLive, DatabaseLive, WorkerEnvironment.layer)

	const VcsRepositoryLive = VcsRepository.layer.pipe(Layer.provide(Base))
	const VcsSyncQueueLive = VcsSyncQueue.layer.pipe(Layer.provide(WorkerEnvironment.layer))
	const VcsScheduledSyncServiceLive = VcsScheduledSyncService.layer.pipe(
		Layer.provide(Layer.mergeAll(VcsRepositoryLive, VcsSyncQueueLive)),
	)

	return VcsScheduledSyncServiceLive.pipe(
		Layer.provideMerge(telemetry.layer),
		Layer.provideMerge(ConfigLive),
	)
}

export const flushVcsTelemetry = (env: Record<string, unknown>) => telemetry.flush(env)

// The cron program: enqueue a periodic refresh per processable installation. Any
// failure is logged (not rethrown) so a scheduled tick never surfaces as an
// unhandled rejection — the next tick (12h later) retries from a clean slate.
export const runScheduledSync = Effect.gen(function* () {
	const scheduler = yield* VcsScheduledSyncService
	const result = yield* scheduler.runScheduledSync()
	// Mirror the counts onto the tick span (the service method annotates its own
	// child span) so cron-level traces are filterable without drilling in.
	yield* Effect.annotateCurrentSpan({
		"vcs.scheduled.installations_total": result.installationsTotal,
		"vcs.scheduled.enqueued": result.enqueued,
		"vcs.scheduled.skipped": result.skipped,
	})
	yield* Effect.logInfo("VCS scheduled sync tick complete").pipe(
		Effect.annotateLogs({
			installationsTotal: result.installationsTotal,
			enqueued: result.enqueued,
			skipped: result.skipped,
		}),
	)
}).pipe(
	Effect.withSpan("VcsScheduledSync.tick"),
	Effect.catchCause((cause) =>
		Effect.logError("VCS scheduled sync tick failed").pipe(
			Effect.annotateLogs({ error: Cause.pretty(cause) }),
		),
	),
)

export const processBatch = (batch: MessageBatch<unknown>) =>
	Effect.gen(function* () {
		const service = yield* VcsSyncService
		yield* Effect.forEach(
			batch.messages,
			(message) =>
				service.processMessage(message.body).pipe(
					Effect.matchCauseEffect({
						onFailure: (cause) => {
							// A rate limit too far out to ride inline → redeliver this message
							// only once the VCS's budget is back, instead of an immediate retry.
							const failure = Option.getOrUndefined(Cause.findErrorOption(cause))

							const delaySeconds =
								failure?._tag === "@maple/http/errors/VcsRateLimitedError"
									? clampQueueDelaySeconds(failure.retryAfterSeconds)
									: undefined
							const isDelaySecondsSet = delaySeconds !== undefined

							return Effect.logError("VCS sync message failed").pipe(
								Effect.annotateLogs({
									error: Cause.pretty(cause),
									...(isDelaySecondsSet ? { retryDelaySeconds: delaySeconds } : {}),
								}),
								Effect.flatMap(() =>
									Effect.sync(() =>
										isDelaySecondsSet
											? message.retry({ delaySeconds })
											: message.retry(),
									),
								),
							)
						},
						onSuccess: () => Effect.sync(() => message.ack()),
					}),
				),
			{ discard: true },
		)
	}).pipe(
		Effect.withSpan("VcsSyncQueue.processBatch", {
			attributes: { "messaging.batch.message_count": batch.messages.length },
		}),
	)
