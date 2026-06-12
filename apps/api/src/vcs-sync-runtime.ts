import type { MessageBatch } from "@cloudflare/workers-types"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Cause, Effect, Layer } from "effect"
import { DatabaseD1Live } from "./lib/DatabaseD1Live"
import { Env } from "./lib/Env"
import { GithubAppClient } from "./services/github/GithubAppClient"
import { GithubProvider } from "./services/github/GithubProvider"
import { VcsProviderRegistry } from "./services/vcs/VcsProviderRegistry"
import { VcsRepository } from "./services/vcs/VcsRepository"
import { VcsSyncQueue } from "./services/vcs/VcsSyncQueue"
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
	const GithubAppClientLive = GithubAppClient.layer.pipe(Layer.provide(EnvLive))
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

export const flushVcsTelemetry = (env: Record<string, unknown>) => telemetry.flush(env)

export const processBatch = (batch: MessageBatch<unknown>) =>
	Effect.gen(function* () {
		const service = yield* VcsSyncService
		yield* Effect.forEach(
			batch.messages,
			(message) =>
				service.processMessage(message.body).pipe(
					Effect.matchCauseEffect({
						onFailure: (cause) =>
							Effect.logError("VCS sync message failed").pipe(
								Effect.annotateLogs({ error: Cause.pretty(cause) }),
								Effect.flatMap(() => Effect.sync(() => message.retry())),
							),
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
