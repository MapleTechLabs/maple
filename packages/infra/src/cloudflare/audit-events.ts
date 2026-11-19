/**
 * The org audit log's queues and its write-once archive. api and maple-ai produce to
 * `audit-intake`; the audit-archive Worker is its only consumer: it writes each batch to the
 * locked bucket, then forwards it to `audit-events`, which api consumes into the warehouse.
 * api holds no binding to the bucket and cannot consume `audit-intake`.
 */
import { REGION_INFRA } from "../region.ts"
import { stageDeployment, stageNamed } from "./stack.ts"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import { Config, Effect } from "effect"
import { resolveWorkerName } from "./stage.ts"
import type { MapleStage } from "./stage.ts"

/** Org audit-log entries on their way to the archive; what producers send to. */
export const AuditIntakeQueue = Cloudflare.Queues.Queue("audit-intake", stageNamed("audit-intake"))

/** Archived entries on their way to the warehouse; api consumes it. */
export const AuditEventsQueue = Cloudflare.Queues.Queue("audit-events", stageNamed("audit-events"))

/** Audit entries that exhausted retries on either queue. No consumer on purpose: kept for inspection. */
export const AuditEventsDlq = Cloudflare.Queues.Queue("audit-events-dlq", stageNamed("audit-events-dlq"))

export const AUDIT_ARCHIVE_PREFIX = "audit/"
export const AUDIT_ARCHIVE_RETENTION_DAYS_DEFAULT = 365

/** Plan-time: how long each archived object stays undeletable. */
export const auditArchiveRetentionDays = Config.Int("MAPLE_AUDIT_ARCHIVE_RETENTION_DAYS").pipe(
	Config.withDefault(AUDIT_ARCHIVE_RETENTION_DAYS_DEFAULT),
)

/**
 * The lock rule, prd only: a locked object blocks bucket deletion, so a preview or dev stage
 * with one could never be torn down.
 */
export const auditArchiveLocks = (
	stage: MapleStage,
	retentionDays: number,
): Array<Cloudflare.R2.BucketLockRule> =>
	stage.kind === "prd"
		? [
				{
					id: "audit-write-once",
					enabled: true,
					prefix: AUDIT_ARCHIVE_PREFIX,
					condition: { type: "Age", maxAgeSeconds: retentionDays * 24 * 60 * 60 },
				},
			]
		: []

/**
 * `audit/<orgId>/<yyyy>/<mm>/<dd>/<batch-id>.ndjson`, one object per org per delivered batch.
 * Never add or change `jurisdiction` or `locationHint`: either replaces the bucket.
 */
export const AuditArchiveBucket = Cloudflare.R2.Bucket(
	// Own id: alchemy keys state by id across types, and the Worker is "audit-archive".
	"audit-archive-r2",
	Effect.gen(function* () {
		if (globalThis.__ALCHEMY_RUNTIME__) return {}
		const { stage, region } = yield* stageDeployment
		const retentionDays = yield* auditArchiveRetentionDays.pipe(Effect.orDie)
		const props: Cloudflare.R2.BucketProps = {
			name: resolveWorkerName("audit-archive", stage, region),
			jurisdiction: REGION_INFRA[region].storageJurisdiction,
			locks: auditArchiveLocks(stage, retentionDays),
		}
		return props
	}),
).pipe(RemovalPolicy.retain())
