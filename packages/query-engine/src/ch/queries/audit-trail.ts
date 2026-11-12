// The unified audit trail: audit events from connected platforms and Maple itself, in one shape.
// Every read is pinned to the managed route, like `audit_log`: the table is written through
// `ingest` and does not exist in a BYO ClickHouse.

import { Schema } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, param } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { CHNumber } from "../schema"
import { orgIdParam } from "../tables"

/**
 * Which optional filters a listing applies. Every set flag binds a parameter of the same name at
 * compile time; the values themselves never enter the SQL.
 */
export interface AuditTrailEventsOpts {
	readonly provider?: boolean
	readonly account?: boolean
	readonly category?: boolean
	readonly outcome?: boolean
	readonly action?: boolean
	/** Matches the actor's provider id or their email, whichever the caller has. */
	readonly actor?: boolean
	/** With `actor`: a second id the same person acts under (a Maple member's user id). */
	readonly actorAlias?: boolean
	readonly since?: boolean
	readonly until?: boolean
	/** Keyset cursor: only events that sort after `beforeOccurredAt` / `beforeId`, newest first. */
	readonly before?: boolean
	readonly limit: number
}

/**
 * One org's audit events, newest first, keyset-paginated on the sorting key. A redelivered event
 * ReplacingMergeTree has not merged yet can appear twice; the service collapses it by id.
 */
export function auditTrailEventsQuery(opts: AuditTrailEventsOpts) {
	return (
		from(Datasources.auditTrailEvents)
			.select(($) => ({
				id: $.Id,
				occurredAt: $.OccurredAt,
				ingestedAt: $.IngestedAt,
				provider: $.Provider,
				account: $.Account,
				providerEventId: $.ProviderEventId,
				actorType: $.ActorType,
				actorId: $.ActorId,
				actorName: $.ActorName,
				actorEmail: $.ActorEmail,
				action: $.Action,
				category: $.Category,
				outcome: $.Outcome,
				outcomeReason: $.OutcomeReason,
				targetType: $.TargetType,
				targetId: $.TargetId,
				targetName: $.TargetName,
				originIp: $.OriginIp,
				originCountry: $.OriginCountry,
				userAgent: $.UserAgent,
				raw: $.Raw,
			}))
			.where(($) => [
				$.OrgId.eq(orgIdParam),
				CH.whenTrue(!!opts.provider, () => $.Provider.eq(param.string("provider"))),
				CH.whenTrue(!!opts.account, () => $.Account.eq(param.string("account"))),
				CH.whenTrue(!!opts.category, () => $.Category.eq(param.string("category"))),
				CH.whenTrue(!!opts.outcome, () => $.Outcome.eq(param.string("outcome"))),
				CH.whenTrue(!!opts.action, () => $.Action.eq(param.string("action"))),
				CH.whenTrue(!!opts.actor, () => {
					const byActor = $.ActorId.eq(param.string("actor")).or(
						$.ActorEmail.eq(param.string("actor")),
					)
					return opts.actorAlias ? byActor.or($.ActorId.eq(param.string("actorAlias"))) : byActor
				}),
				CH.whenTrue(!!opts.since, () => $.OccurredAt.gte(param.dateTime("since"))),
				CH.whenTrue(!!opts.until, () => $.OccurredAt.lte(param.dateTime("until"))),
				CH.whenTrue(!!opts.before, () =>
					$.OccurredAt.lt(param.dateTime("beforeOccurredAt")).or(
						$.OccurredAt.eq(param.dateTime("beforeOccurredAt")).and(
							$.Id.lt(param.string("beforeId")),
						),
					),
				),
			])
			// Unmerged copies of one event: the first write first, the one the service keeps.
			.orderBy(["occurredAt", "desc"], ["id", "desc"], ["ingestedAt", "asc"])
			.limit(opts.limit)
			.format("JSON")
			.route("ingest")
	)
}

/** Which optional filters a count applies; each set flag binds a parameter of the same name. */
export interface AuditTrailCountOpts {
	readonly provider?: boolean
	readonly category?: boolean
	readonly outcome?: boolean
	readonly action?: boolean
}

export const auditTrailCountRowSchema = Schema.Struct({ events: CHNumber })

/** How far back an event may have happened and still be counted when it arrives. */
const AUDIT_TRAIL_LATE_ARRIVAL_SECONDS = 7 * 24 * 60 * 60

/**
 * How many of one org's events arrived in `(start, end]`, for a detection. Distinct ids, not
 * rows: a redelivery is a second row until the table merges it. Params: orgId, start, end.
 */
export function auditTrailCountQuery(opts: AuditTrailCountOpts = {}) {
	return from(Datasources.auditTrailEvents)
		.select(($) => ({ events: CH.uniqExact($.Id) }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.IngestedAt.gt(param.dateTime("start")),
			$.IngestedAt.lte(param.dateTime("end")),
			// Prunes partitions and the sorting key, which follow OccurredAt. An event can
			// arrive late; a week covers every provider's delivery delay.
			$.OccurredAt.gte(CH.intervalSub(param.dateTime("start"), AUDIT_TRAIL_LATE_ARRIVAL_SECONDS)),
			CH.whenTrue(!!opts.provider, () => $.Provider.eq(param.string("provider"))),
			CH.whenTrue(!!opts.category, () => $.Category.eq(param.string("category"))),
			CH.whenTrue(!!opts.outcome, () => $.Outcome.eq(param.string("outcome"))),
			CH.whenTrue(!!opts.action, () => $.Action.eq(param.string("action"))),
		])
		.format("JSON")
		.route("ingest")
}
