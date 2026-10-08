import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, paramPlaceholder } from "@maple-dev/effect-orm/clickhouse"
import { AuditLog, orgIdParam } from "../tables"

/**
 * Which optional filters a listing applies. Every set flag binds a parameter of
 * the same name at compile time; the values themselves never enter the SQL.
 */
export interface AuditLogEntriesOpts {
	readonly actorType?: boolean
	readonly userId?: boolean
	readonly apiKeyId?: boolean
	readonly actorId?: boolean
	readonly affectedUserId?: boolean
	readonly action?: boolean
	readonly outcome?: boolean
	readonly resourceType?: boolean
	readonly resourceId?: boolean
	readonly changedField?: boolean
	readonly requestId?: boolean
	readonly since?: boolean
	readonly until?: boolean
	readonly limit: number
	readonly offset: number
}

/**
 * One org's audit log, newest first, offset-paginated. Pinned to the managed
 * route: the table is written through `ingest` and does not exist in a BYO
 * ClickHouse. A redelivered entry ReplacingMergeTree has not merged yet can
 * appear twice here; the service collapses it by id.
 */
export function auditLogEntriesQuery(opts: AuditLogEntriesOpts) {
	return from(AuditLog)
		.select(($) => ({
			id: $.Id,
			occurredAt: $.OccurredAt,
			recordedAt: $.RecordedAt,
			actorType: $.ActorType,
			userId: $.UserId,
			apiKeyId: $.ApiKeyId,
			actorId: $.ActorId,
			actorLabel: $.ActorLabel,
			affectedUserId: $.AffectedUserId,
			source: $.Source,
			action: $.Action,
			outcome: $.Outcome,
			denialReason: $.DenialReason,
			resourceType: $.ResourceType,
			resourceId: $.ResourceId,
			changedFields: $.ChangedFields,
			changes: $.Changes,
			metadata: $.Metadata,
			requestId: $.RequestId,
			originIp: $.OriginIp,
			originCountry: $.OriginCountry,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			CH.whenTrue(!!opts.actorType, () => $.ActorType.eq(param.string("actorType"))),
			CH.whenTrue(!!opts.userId, () => $.UserId.eq(param.string("userId"))),
			CH.whenTrue(!!opts.apiKeyId, () => $.ApiKeyId.eq(param.string("apiKeyId"))),
			CH.whenTrue(!!opts.actorId, () => $.ActorId.eq(param.string("actorId"))),
			CH.whenTrue(!!opts.affectedUserId, () => $.AffectedUserId.eq(param.string("affectedUserId"))),
			CH.whenTrue(!!opts.action, () => $.Action.eq(param.string("action"))),
			CH.whenTrue(!!opts.outcome, () => $.Outcome.eq(param.string("outcome"))),
			CH.whenTrue(!!opts.resourceType, () => $.ResourceType.eq(param.string("resourceType"))),
			CH.whenTrue(!!opts.resourceId, () => $.ResourceId.eq(param.string("resourceId"))),
			// Array membership has no builder verb yet; the placeholder keeps the
			// value parameterised exactly like the typed comparisons above.
			opts.changedField
				? CH.rawCond(`has(ChangedFields, ${paramPlaceholder("string", "changedField")})`)
				: undefined,
			CH.whenTrue(!!opts.requestId, () => $.RequestId.eq(param.string("requestId"))),
			CH.whenTrue(!!opts.since, () => $.OccurredAt.gte(param.dateTime("since"))),
			CH.whenTrue(!!opts.until, () => $.OccurredAt.lte(param.dateTime("until"))),
		])
		.orderBy(["occurredAt", "desc"], ["id", "desc"])
		.limit(opts.limit)
		.offset(opts.offset)
		.format("JSON")
		.route("ingest")
}

/** One listed entry as the warehouse returns it: `''` for absent values, JSON text for documents. */
export interface AuditLogEntriesOutput {
	readonly id: string
	readonly occurredAt: DateTime.Utc
	readonly recordedAt: DateTime.Utc
	readonly actorType: string
	readonly userId: string
	readonly apiKeyId: string
	readonly actorId: string
	readonly actorLabel: string
	readonly affectedUserId: string
	readonly source: string
	readonly action: string
	readonly outcome: string
	readonly denialReason: string
	readonly resourceType: string
	readonly resourceId: string
	readonly changedFields: ReadonlyArray<string>
	readonly changes: string
	readonly metadata: string
	readonly requestId: string
	readonly originIp: string
	readonly originCountry: string
}
