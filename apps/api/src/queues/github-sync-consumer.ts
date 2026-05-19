import { decodeGithubSyncJob, type GithubSyncJob } from "@maple/domain/queues/github-jobs"
import { Effect, Exit, Match } from "effect"
import { GithubSyncQueue } from "../services/GithubSyncQueue"
import { GithubSyncService } from "../services/GithubSyncService"

const RETRY_DELAY_SECONDS = 60

type MessageLike = {
	readonly id?: string
	readonly body: unknown
	ack?: () => void
	retry?: (options?: { delaySeconds?: number }) => void
}

type BatchLike = {
	readonly messages: ReadonlyArray<MessageLike>
}

const dispatch = (job: GithubSyncJob) =>
	Effect.gen(function* () {
		const sync = yield* GithubSyncService
		const queue = yield* GithubSyncQueue
		return yield* Match.value(job).pipe(
			Match.tag("BackfillRepo", (j) =>
				Effect.gen(function* () {
					const progress = yield* sync.runBackfill({
						orgId: j.orgId,
						repoId: j.repoId,
						sinceUnixMs: j.sinceUnixMs,
						cursor: j.cursor,
					})
					if (!progress.done && progress.cursor) {
						yield* queue.enqueue({
							_tag: "BackfillRepo",
							orgId: j.orgId,
							repoId: j.repoId,
							sinceUnixMs: j.sinceUnixMs,
							cursor: progress.cursor,
						} as GithubSyncJob)
					}
				}),
			),
			Match.tag("SyncWebhookPush", (j) =>
				sync.runWebhookPush({
					orgId: j.orgId,
					installationId: j.installationId,
					owner: j.owner,
					name: j.name,
					ref: j.ref,
					before: j.before,
					after: j.after,
					forced: j.forced,
					commitShas: j.commitShas,
				}),
			),
			Match.tag("ResolveUnknownSha", (j) =>
				sync.runResolveUnknownSha({ orgId: j.orgId, sha: j.sha }),
			),
			Match.tag("ReconcileInstallation", (j) =>
				sync.runReconcile({ orgId: j.orgId, installationId: j.installationId }),
			),
			Match.exhaustive,
		)
	})

export const processGithubSyncBatch = (batch: BatchLike) =>
	Effect.gen(function* () {
		for (const message of batch.messages) {
			const decodedExit = yield* Effect.exit(decodeGithubSyncJob(message.body))
			if (Exit.isFailure(decodedExit)) {
				yield* Effect.logError("[github-sync] malformed message, dropping").pipe(
					Effect.annotateLogs({ messageId: message.id ?? "<unknown>" }),
				)
				message.ack?.()
				continue
			}
			const job = decodedExit.value
			const dispatchExit = yield* Effect.exit(dispatch(job))
			if (Exit.isFailure(dispatchExit)) {
				yield* Effect.logError("[github-sync] job failed, will retry").pipe(
					Effect.annotateLogs({
						messageId: message.id ?? "<unknown>",
						tag: job._tag,
					}),
				)
				message.retry?.({ delaySeconds: RETRY_DELAY_SECONDS })
				continue
			}
			message.ack?.()
		}
	})
