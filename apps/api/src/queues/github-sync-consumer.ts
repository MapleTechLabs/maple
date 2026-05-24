import { decodeGithubSyncJob, type GithubSyncJob } from "@maple/domain/queues/github-jobs"
import { Effect, Match } from "effect"
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

const dispatch = Effect.fn("GithubSyncConsumer.dispatch")(function* (job: GithubSyncJob) {
	yield* Effect.annotateCurrentSpan({ "job.orgId": job.orgId, "job.tag": job._tag })
	const sync = yield* GithubSyncService
	const queue = yield* GithubSyncQueue

	yield* Match.value(job).pipe(
		Match.tag("BackfillRepo", (job) =>
			Effect.gen(function* () {
				const progress = yield* sync.runBackfill({
					orgId: job.orgId,
					repoId: job.repoId,
					sinceUnixMs: job.sinceUnixMs,
					cursor: job.cursor,
				})

				if (!progress.done && progress.cursor) {
					yield* queue.enqueue({
						_tag: "BackfillRepo" as const,
						orgId: job.orgId,
						repoId: job.repoId,
						sinceUnixMs: job.sinceUnixMs,
						cursor: progress.cursor,
					})
				}
			}),
		),
		Match.tag("SyncWebhookPush", (job) =>
			sync.runWebhookPush({
				orgId: job.orgId,
				installationId: job.installationId,
				owner: job.owner,
				name: job.name,
				ref: job.ref,
				before: job.before,
				after: job.after,
				forced: job.forced,
				commitShas: job.commitShas,
			}),
		),
		Match.tag("ResolveUnknownSha", (job) =>
			sync.runResolveUnknownSha({ orgId: job.orgId, sha: job.sha }),
		),
		Match.tag("ReconcileInstallation", (job) =>
			sync.runReconcile({ orgId: job.orgId, installationId: job.installationId }),
		),
		Match.exhaustive,
	)
})

const processMessage = Effect.fn("GithubSyncConsumer.processMessage")(function* (message: MessageLike) {
	yield* Effect.annotateCurrentSpan({ "message.id": message.id ?? "<unknown>" })

	const decodedJob = yield* Effect.result(decodeGithubSyncJob(message.body))

	if (decodedJob._tag === "Failure") {
		yield* Effect.annotateCurrentSpan({ "message.outcome": "dropped" })

		yield* Effect.logError("[github-sync] malformed message, dropping", decodedJob.failure)
		yield* Effect.sync(() => message.ack?.())
		return
	}

	const dispatchResult = yield* Effect.result(dispatch(decodedJob.success))

	if (dispatchResult._tag === "Failure") {
		yield* Effect.annotateCurrentSpan({ "message.outcome": "retried" })

		yield* Effect.logError("[github-sync] job failed, will retry", dispatchResult.failure)
		yield* Effect.sync(() => message.retry?.({ delaySeconds: RETRY_DELAY_SECONDS }))
		return
	}

	yield* Effect.annotateCurrentSpan({ "message.outcome": "acked" })
	yield* Effect.sync(() => message.ack?.())
})

export const processGithubSyncBatch = (batch: BatchLike) =>
	Effect.forEach(batch.messages, processMessage, { discard: true }).pipe(
		Effect.withSpan("processGithubSyncBatch", {
			attributes: { "batch.size": batch.messages.length },
		}),
	)
