import { Effect } from "effect"
import { GithubInstallationRepo } from "../services/GithubInstallationRepo"
import { GithubSyncQueue } from "../services/GithubSyncQueue"

// Fires every 6h via the `scheduled` worker handler. Enqueues a reconcile
// job for every active installation — catches webhooks GitHub failed to
// deliver, refreshes repo lists, and re-syncs installation metadata.
export const runGithubScheduledReconcile = Effect.fn("CronScheduler.runGithubScheduledReconcile")(
	function* () {
		const installationRepo = yield* GithubInstallationRepo
		const queue = yield* GithubSyncQueue
		const installations = yield* installationRepo.listActive()

		if (installations.length === 0) {
			yield* Effect.logInfo("[cron] no active GitHub installations to reconcile")
			return
		}

		yield* queue.enqueueBatch(
			installations.map((row) => ({
				_tag: "ReconcileInstallation" as const,
				orgId: row.orgId,
				installationId: row.installationId,
			})),
		)
		yield* Effect.logInfo(`[cron] enqueued ${installations.length} GitHub reconcile jobs`)
	},
)
