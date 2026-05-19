import { githubInstallations, type GithubInstallationRow } from "@maple/db"
import { isNull } from "drizzle-orm"
import { Effect } from "effect"
import { Database, type DatabaseClient } from "../services/DatabaseLive"
import { GithubSyncQueue } from "../services/GithubSyncQueue"

export const runScheduledReconcile = Effect.gen(function* () {
	const database = yield* Database
	const queue = yield* GithubSyncQueue
	const installations = (yield* database
		.execute((db) =>
			db
				.select()
				.from(githubInstallations)
				.where(isNull(githubInstallations.suspendedAt)),
		)
		.pipe(Effect.orDie)) as ReadonlyArray<GithubInstallationRow>

	if (installations.length === 0) {
		yield* Effect.logInfo("[cron] no active GitHub installations to reconcile")
		return
	}

	yield* queue.enqueueBatch(
		installations.map(
			(row) =>
				({
					_tag: "ReconcileInstallation" as const,
					orgId: row.orgId,
					installationId: row.installationId,
				}) as const,
		),
	)
	yield* Effect.logInfo(
		`[cron] enqueued ${installations.length} GitHub reconcile jobs`,
	)
})

export type DatabaseClientLike = DatabaseClient
