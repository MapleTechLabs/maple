// Session tags: cheap, rule-based labels computed from `session_replays` alone.
//
// Every tag is defined here once, in SQL, and three consumers read it: the list's
// `tags` filter (a SessionId semi-join), the sidebar's tag counts, and the `quality`
// column each list row carries. Nothing is stored, so changing a threshold
// re-tags history. Tags that need `session_events` belong in a rollup, not here.

import * as CH from "@maple-dev/effect-clickhouse/expr"
import * as T from "@maple-dev/effect-clickhouse/types"
import { from, fromQuery, type ColumnAccessor } from "@maple-dev/effect-clickhouse"
import { SESSION_QUALITY_TAGS, SESSION_TAG_THRESHOLDS, type SessionTag } from "@maple/domain/query-engine"
import { SessionReplays } from "../tables"
import { isBotCond } from "../user-agent"

type ReplaysAccessor = ColumnAccessor<typeof SessionReplays.columns>
type ReplaysWhere = ($: ReplaysAccessor) => Array<CH.Condition | undefined>

// dateDiff(unit, start, end) as whole units; the DSL has no typed wrapper.
function dateDiffMs(start: CH.Expr<string>, end: CH.Expr<string>): CH.Expr<number> {
	return CH.compileTypedFnCall<number>("dateDiff", T.int64.schema, CH.lit("millisecond"), start, end)
}

// Only the ended row carries DurationMs. A tab killed without its unload row has
// heartbeats instead, so fall back to the last activity, as the list does.
function effectiveDurationMs($: ReplaysAccessor): CH.Expr<number> {
	const start = CH.argMax($.StartTime, $.Version)
	return CH.coalesce(
		CH.argMax($.DurationMs, $.Version),
		dateDiffMs(start, CH.coalesce(CH.argMax($.LastActivityAt, $.Version), start)),
	)
}

/**
 * The session's quality tier, over a query grouped by SessionId. A session still
 * in progress reads as its shortest tier until it grows out of it.
 */
export function sessionQualityExpr($: ReplaysAccessor): CH.Expr<string> {
	const duration = effectiveDurationMs($)
	const clicks = CH.argMax($.ClickCount, $.Version)
	const pages = CH.argMax($.PageViews, $.Version)
	const errors = CH.argMax($.ErrorCount, $.Version)
	return CH.multiIf<string>(
		[
			[isBotCond(CH.argMax($.UserAgent, $.Version)), CH.lit("bot")],
			[duration.lt(SESSION_TAG_THRESHOLDS.bounceMaxMs).and(clicks.eq(0)), CH.lit("bounce")],
			[pages.lte(1).and(clicks.eq(0)).and(errors.eq(0)), CH.lit("idle")],
			[
				pages
					.lte(1)
					.and(clicks.lte(SESSION_TAG_THRESHOLDS.glanceMaxClicks))
					.and(errors.eq(0))
					.and(duration.lt(SESSION_TAG_THRESHOLDS.glanceMaxMs)),
				CH.lit("glance"),
			],
		],
		CH.lit("engaged"),
	)
}

/** One row per session in the window with every fact a tag is decided from. */
function sessionTagFactsQuery(where: ReplaysWhere) {
	return from(SessionReplays)
		.select(($) => ({
			sessionId: $.SessionId,
			quality: sessionQualityExpr($),
			signedIn: CH.if_(CH.argMax($.UserId, $.Version).neq(""), CH.lit(1), CH.lit(0)),
			newVisitor: CH.argMax($.VisitorIsNew, $.Version),
		}))
		.where(where)
		.groupBy("sessionId")
}

interface TagFacts {
	readonly quality: CH.Expr<string>
	readonly signedIn: CH.Expr<number>
	readonly newVisitor: CH.Expr<number>
}

function tagCondition($: TagFacts, tag: SessionTag): CH.Condition {
	switch (tag) {
		case "signed_in":
			return $.signedIn.eq(1)
		case "new_visitor":
			return $.newVisitor.eq(1)
		default:
			return $.quality.eq(tag)
	}
}

/** SessionIds carrying every one of `tags`, for `inSubquery` on a session query. */
export function taggedSessionIds(tags: ReadonlyArray<SessionTag>, where: ReplaysWhere) {
	return fromQuery(sessionTagFactsQuery(where), "t")
		.select(($) => ({ SessionId: $.sessionId }))
		.where(($) => tags.map((tag) => tagCondition($, tag)))
}

const isQualityTag = (tag: SessionTag) => SESSION_QUALITY_TAGS.some((quality) => quality === tag)

/**
 * Sessions per tag, as a facet branch: one row per tag, `name` being the tag.
 *
 * Each count is what ticking that tag would return: it is counted under the other
 * selected tags. Tiers replace one another in the sidebar, so a tier is counted
 * under the selected traits only; a trait under the selected tier and other traits.
 */
export function sessionTagFacet(where: ReplaysWhere, selected: ReadonlyArray<SessionTag> = []) {
	const under = ($: TagFacts, own: CH.Condition, context: ReadonlyArray<SessionTag>) =>
		context.reduce((cond, tag) => cond.and(tagCondition($, tag)), own)
	const traitsOnly = selected.filter((tag) => !isQualityTag(tag))
	const othersThan = (trait: SessionTag) => selected.filter((tag) => tag !== trait)
	return fromQuery(sessionTagFactsQuery(where), "t")
		.select(($) => ({
			name: CH.arrayJoin<string>(
				CH.arrayFilter(
					"tag -> tag != ''",
					CH.arrayOf(
						traitsOnly.length === 0
							? $.quality
							: CH.if_(under($, $.quality.neq(""), traitsOnly), $.quality, CH.lit("")),
						CH.if_(
							under($, $.signedIn.eq(1), othersThan("signed_in")),
							CH.lit("signed_in"),
							CH.lit(""),
						),
						CH.if_(
							under($, $.newVisitor.eq(1), othersThan("new_visitor")),
							CH.lit("new_visitor"),
							CH.lit(""),
						),
					),
				),
			),
			count: CH.count(),
			facetType: CH.lit("tag"),
		}))
		.groupBy("name")
}
