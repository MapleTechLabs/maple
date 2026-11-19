/**
 * One delivered batch of audit events: each org's entries become one NDJSON object in the
 * write-once bucket, then go on to the warehouse queue. Archived first, so nothing reaches the
 * warehouse without a locked copy. A retry writes a new object; readers dedupe on the entry `id`.
 */
import { Cause, DateTime, Effect, Schema, Array as Arr, String as Str } from "effect"
import { AUDIT_ARCHIVE_PREFIX } from "@maple/infra/cloudflare"

/** The slice of a queue message the archive uses. */
export interface ArchiveMessage {
	readonly id: string
	readonly body: unknown
	readonly attempts: number
	readonly ack: () => void
	readonly retry: () => void
}

export class AuditArchiveWriteError extends Schema.TaggedError<AuditArchiveWriteError>()(
	"@maple/audit-archive/AuditArchiveWriteError",
	{ message: Schema.String, key: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export class AuditArchiveForwardError extends Schema.TaggedError<AuditArchiveForwardError>()(
	"@maple/audit-archive/AuditArchiveForwardError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

export interface ArchivePorts {
	/** Create-only write of one object; the bucket lock refuses an overwrite. */
	readonly putObject: (key: string, body: string) => Effect.Effect<void, AuditArchiveWriteError>
	/** Hands the original bodies to the warehouse queue, unchanged. */
	readonly forward: (bodies: ReadonlyArray<unknown>) => Effect.Effect<void, AuditArchiveForwardError>
	readonly newBatchId: Effect.Effect<string>
}

/** Entries whose body names no usable org land here rather than being lost. */
export const UNATTRIBUTED_ORG = "_unattributed"
const SAFE_ORG_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The org an entry belongs to, read defensively: an archive keeps even a malformed body. */
export const archiveOrgOf = (body: unknown): string => {
	if (typeof body !== "object" || body === null || !("orgId" in body)) return UNATTRIBUTED_ORG
	const { orgId } = body
	return typeof orgId === "string" && SAFE_ORG_ID.test(orgId) ? orgId : UNATTRIBUTED_ORG
}

const pad = (value: number) => Str.padStart(2, "0")(String(value))

/** `audit/<orgId>/<yyyy>/<mm>/<dd>/<batch-id>.ndjson`, dated by archive time in UTC. */
export const archiveKey = (orgId: string, at: DateTime.Utc, batchId: string) => {
	const parts = DateTime.toPartsUtc(at)
	return `${AUDIT_ARCHIVE_PREFIX}${orgId}/${parts.year}/${pad(parts.month)}/${pad(parts.day)}/${batchId}.ndjson`
}

const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** One line per message: the queue's message id and the body exactly as produced. */
export const toNdjson = (messages: ReadonlyArray<ArchiveMessage>) =>
	Effect.forEach(messages, (message) =>
		encodeLine({ messageId: message.id, body: message.body ?? null }),
	).pipe(Effect.map((lines) => Arr.join(lines, "\n") + "\n"))

/** Past `maxRetries` the retry hands the message to the DLQ; the log makes that hand-off visible. */
const retryOrExhaust = (message: ArchiveMessage, orgId: string, error: string, maxRetries: number) =>
	(message.attempts > maxRetries
		? Effect.logError("Audit archive exhausted retries; routed to dead letter queue")
		: Effect.logWarning("Audit archive write failed; retrying")
	).pipe(
		Effect.annotateLogs({ attempt: message.attempts, orgId, error }),
		Effect.andThen(Effect.sync(() => message.retry())),
	)

const groupByOrg = (messages: ReadonlyArray<ArchiveMessage>) =>
	Arr.reduce(messages, new Map<string, Array<ArchiveMessage>>(), (groups, message) => {
		const orgId = archiveOrgOf(message.body)
		groups.set(orgId, [...(groups.get(orgId) ?? []), message])
		return groups
	})

export const processArchiveBatch = Effect.fn("AuditArchive.processBatch")(function* (
	messages: ReadonlyArray<ArchiveMessage>,
	maxRetries: number,
	ports: ArchivePorts,
) {
	const at = yield* DateTime.now
	yield* Effect.forEach(
		groupByOrg(messages),
		([orgId, group]) =>
			Effect.gen(function* () {
				const batchId = yield* ports.newBatchId
				const key = archiveKey(orgId, at, batchId)
				const body = yield* toNdjson(group)
				yield* ports.putObject(key, body)
				yield* ports.forward(Arr.map(group, (message) => message.body))
				yield* Effect.forEach(group, (message) => Effect.sync(() => message.ack()), { discard: true })
			}).pipe(
				Effect.withSpan("AuditArchive.writeOrgBatch", {
					attributes: { orgId, "maple.audit.batch_rows": group.length },
				}),
				// Interruption is not an attempt: re-raised, the batch stays unacked and is redelivered.
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.forEach(
								group,
								(message) => retryOrExhaust(message, orgId, Cause.pretty(cause), maxRetries),
								{ discard: true },
							),
				),
			),
		{ concurrency: 3, discard: true },
	)
})
