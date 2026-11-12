import { createHash } from "node:crypto"
import type { InferQueryOutput } from "@maple-dev/effect-orm/clickhouse"
import type { AuditTrailEvent } from "@maple/domain/audit-trail"
import type { AuditTrailEntry } from "@maple/domain/http"
import type { AuditTrailEventsRow } from "@maple/domain/tinybird"
import type { OrgId } from "@maple/primitives"
import type { auditTrailEventsQuery } from "@maple/query-engine/ch"
import { warehouseDateTime64 } from "@maple/query-engine/datetime"
import { DateTime, Option, Schema, String as Str } from "effect"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeRawJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

/**
 * The stored row's key, the first 32 hex characters of sha256 over `provider\naccount\neventId`.
 * A writer in another language has to derive the same key, or its redeliveries stop collapsing.
 */
export const auditTrailEventId = (
	event: Pick<AuditTrailEvent, "provider" | "account" | "providerEventId">,
): string =>
	Str.slice(0, 32)(sha256Hex(`${event.provider}\n${event.account ?? ""}\n${event.providerEventId}`))

/** Above any ingest time in ms, so `Version` stays positive and falls as time rises. */
const VERSION_CEILING_MS = 9_999_999_999_999

/** Lower an adapter's event to its `audit_trail_events` row; `ingestedAtMs` is the write time. */
export const auditTrailEventToRow = (
	orgId: OrgId,
	event: AuditTrailEvent,
	ingestedAtMs: number,
): AuditTrailEventsRow => ({
	OrgId: orgId,
	Id: auditTrailEventId(event),
	OccurredAt: warehouseDateTime64(event.occurredAtMs),
	IngestedAt: warehouseDateTime64(ingestedAtMs),
	Provider: event.provider,
	Account: event.account ?? "",
	ProviderEventId: event.providerEventId,
	ActorType: event.actor.type,
	ActorId: event.actor.id ?? "",
	ActorName: event.actor.name ?? "",
	ActorEmail: event.actor.email ?? "",
	Action: event.action,
	Category: event.category,
	Outcome: event.outcome,
	TargetType: event.target?.type ?? "",
	TargetId: event.target?.id ?? "",
	TargetName: event.target?.name ?? "",
	OriginIp: event.originIp ?? "",
	OriginCountry: event.originCountry ?? "",
	UserAgent: event.userAgent ?? "",
	Raw: event.raw === undefined ? "" : encodeJson(event.raw),
	Version: VERSION_CEILING_MS - ingestedAtMs,
})

/** `''` in the warehouse row is "absent". */
const absent = (value: string): string | null => (value === "" ? null : value)

/**
 * A listed row as the reader sees it. `raw` is whatever the provider sent, written by adapters
 * in two languages: one that is not a JSON object reads as absent and keeps the page.
 */
export const storedRowToEntry = (
	row: InferQueryOutput<ReturnType<typeof auditTrailEventsQuery>>,
): AuditTrailEntry => ({
	id: row.id,
	provider: row.provider,
	account: absent(row.account),
	providerEventId: row.providerEventId,
	occurredAt: DateTime.toEpochMillis(row.occurredAt),
	ingestedAt: DateTime.toEpochMillis(row.ingestedAt),
	actor: {
		type: row.actorType,
		id: absent(row.actorId),
		name: absent(row.actorName),
		email: absent(row.actorEmail),
	},
	action: row.action,
	category: row.category,
	outcome: row.outcome,
	target: { type: absent(row.targetType), id: absent(row.targetId), name: absent(row.targetName) },
	originIp: absent(row.originIp),
	originCountry: absent(row.originCountry),
	userAgent: absent(row.userAgent),
	raw: Option.getOrNull(decodeRawJson(row.raw)),
})
