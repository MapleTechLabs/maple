import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgErasureKind } from "@maple/domain/org-erasure"
import { OrgId } from "@maple/primitives"

/**
 * Customer data a deleted organization still has outside Postgres, queued by the deletion before
 * its purge and drained by the org-eraser Worker's cron. A row is deleted once its target is erased; a
 * failure stays with its error and is retried with backoff. Outlives the org on purpose.
 */
export const OrgErasures = PG.table("org_erasures", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		kind: PG.brand(PG.text, OrgErasureKind),
		/** The chat session id, the object key prefix, or the warehouse datasource to erase. */
		target: PG.text,
		/** A warehouse delete job in flight, polled until it finishes; null when none is. */
		jobId: PG.column(PG.nullable(PG.text), { name: "job_id" }),
		attempts: PG.column(PG.int4, { default: 0 }),
		lastError: PG.column(PG.nullable(PG.text), { name: "last_error" }),
		nextAttemptAt: PG.column(PG.timestamptzMillis, { name: "next_attempt_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		// A retried deletion queues the same targets again; this makes that a no-op.
		PG.uniqueIndex("org_erasures_target_idx", ["orgId", "kind", "target"]),
		PG.index("org_erasures_due_idx", ["nextAttemptAt"]),
	],
	tenantColumn: "orgId",
})

export type OrgErasureRow = PG.SelectRowOf<typeof OrgErasures>
