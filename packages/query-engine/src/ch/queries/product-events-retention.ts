// Retention over `product_events`: of the people who first did one thing in an interval, how
// many did another in each interval after it.
//
// One pass per key. A key's cohort is the interval of its FIRST start event; with `firstEver`
// that first is read over the table's whole history, not the window, so someone who was already
// active before the window is in no cohort. Reading "first" inside the window instead puts every
// existing user into the window's first cohort, which then looks several times larger and better
// retained than the ones after it: the usual way a hand-written retention query is wrong.
//
// Period 0 is the cohort itself (its size). Period n >= 1 is the keys of that cohort with a
// return event in the n-th interval after it. Intervals are calendar days, Monday weeks or
// months, in UTC.
//
// The per-key arrays are raw SQL (`groupUniqArrayIf`, `arrayMap` with a lambda), which the
// builder cannot express; every column the raw strings name is one the same query projects, and
// every user-supplied value (the events) enters through a typed condition, never a string.

import * as CH from "@maple-dev/effect-orm/expr"
import { param, from, fromQuery, inSubquery } from "@maple-dev/effect-orm/clickhouse"
import type { CHQuery, ColumnDefs } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { type DateTime, Result, Schema } from "effect"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam } from "../tables"
import { RETENTION_MAX_PERIODS } from "@maple/query-model"
import { CHNumber } from "../schema"
import {
	LINK_ALIAS,
	eventStepCondition,
	flag,
	hasPopulationFilter,
	identityLinksByVisitor,
	matchingPersonsSubquery,
	personKey,
	type FunnelKeyBy,
	type FunnelStep,
	type OpenJoinAccessor,
	type OpenJoinQuery,
	type ProductEventsFilters,
} from "./product-events"

export type RetentionInterval = "day" | "week" | "month"
/** A session cannot come back in a later interval, so it is not a key. */
export type RetentionKeyBy = Exclude<FunnelKeyBy, "session">
/** An event or a page view; a session step has no place in a history. */
export type RetentionStep = Extract<FunnelStep, { kind: "event" | "page" }>

export interface ProductEventsRetentionOpts {
	/** What puts a key in a cohort: its first such event. Any event when absent. */
	readonly startEvent?: RetentionStep
	/** What counts as coming back. Any event when absent. */
	readonly returnEvent?: RetentionStep
	readonly keyBy: RetentionKeyBy
	readonly interval: RetentionInterval
	/** Intervals after the cohort's own to report, 1..26. */
	readonly periods: number
	/**
	 * `true`: a cohort is the keys whose first start event EVER falls in the window (the whole
	 * table is read for it). `false`: their first start event inside the window, which is cheaper
	 * and counts everyone already active as new in the window's first interval.
	 */
	readonly firstEver: boolean
	/** Narrow the population to keys with a matching session, as a funnel does. */
	readonly filters?: ProductEventsFilters
}

export const productEventsRetentionRowSchema = Schema.Struct({
	/** The cohort interval's first day, `YYYY-MM-DD`. */
	cohort: Schema.String,
	/** 0 for the cohort itself; n for the n-th interval after it. */
	period: CHNumber,
	count: CHNumber,
})
export type ProductEventsRetentionOutput = typeof productEventsRetentionRowSchema.Type

/** A retention definition the builder cannot compile; returned as a `Result` failure. */
export class ProductEventsRetentionError extends Schema.TaggedError<ProductEventsRetentionError>()(
	"@maple/query-engine/ProductEventsRetentionError",
	{
		reason: Schema.Literals(["InvalidPeriods"]),
		message: Schema.String,
	},
) {}

/** The interval a timestamp column falls in, as a Date. */
const bucketOf = (interval: RetentionInterval, column: string): string => {
	switch (interval) {
		case "day":
			return `toDate(${column}, 'UTC')`
		case "week":
			return `toStartOfWeek(${column}, 1, 'UTC')`
		case "month":
			return `toStartOfMonth(${column}, 'UTC')`
	}
}

/** Whole intervals from one bucket to a later one. */
const periodsBetween = (interval: RetentionInterval, from: string, to: string): string => {
	switch (interval) {
		case "day":
			return `dateDiff('day', ${from}, ${to})`
		case "week":
			return `intDiv(dateDiff('day', ${from}, ${to}), 7)`
		case "month":
			return `dateDiff('month', ${from}, ${to})`
	}
}

type EventsColumns = typeof Datasources.productEvents.columns

/**
 * `{ cohort, period, count }`, ordered by cohort then period. A cohort with nobody in it is not
 * a row; a period nobody came back in is not one either, so the reader fills zeros.
 *
 * Cohorts are the keys whose first start event is in `[startTime, endTime)`. Reads return events
 * from `startTime` to the `returnEndTime` parameter, which lets the last cohorts be followed
 * past the end of the cohort window.
 */
export function productEventsRetentionQuery(
	opts: ProductEventsRetentionOpts,
): Result.Result<CHQuery<ColumnDefs, ProductEventsRetentionOutput>, ProductEventsRetentionError> {
	if (!Number.isInteger(opts.periods) || opts.periods < 1 || opts.periods > RETENTION_MAX_PERIODS) {
		return Result.fail(
			new ProductEventsRetentionError({
				reason: "InvalidPeriods",
				message: `periods must be an integer in 1..${RETENTION_MAX_PERIODS}, got ${String(opts.periods)}`,
			}),
		)
	}
	const { keyBy, interval } = opts
	const filters = opts.filters ?? {}

	const events: OpenJoinQuery<EventsColumns> = from(Datasources.productEvents, "e")
	const withIdentity =
		keyBy === "person"
			? events.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (e, link) =>
					e.VisitorId.eq(link.VisitorId),
				)
			: events
	const keyOf = ($: OpenJoinAccessor<EventsColumns>) =>
		personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)

	// Every row that could start a cohort or count as a return, flagged for which.
	const rows = withIdentity
		.select(($) => {
			const starts = opts.startEvent === undefined ? undefined : eventStepCondition($, opts.startEvent)
			const returns =
				opts.returnEvent === undefined ? undefined : eventStepCondition($, opts.returnEvent)
			// A return before the window cannot follow a cohort in it, and would only grow the array.
			const inWindow = $.Timestamp.gte(param.dateTime("startTime"))
			return {
				key: keyOf($),
				ts: $.Timestamp,
				isStart: starts === undefined ? CH.lit(1) : flag(starts),
				isReturn: flag(returns === undefined ? inWindow : returns.and(inWindow)),
			}
		})
		.where(($) => {
			const starts = opts.startEvent === undefined ? undefined : eventStepCondition($, opts.startEvent)
			const returns =
				opts.returnEvent === undefined ? undefined : eventStepCondition($, opts.returnEvent)
			return [
				$.OrgId.eq(orgIdParam),
				$.Timestamp.lte(param.dateTime("returnEndTime")),
				opts.firstEver ? undefined : $.Timestamp.gte(param.dateTime("startTime")),
				// With both events named, nothing else can matter: read only those rows.
				starts !== undefined && returns !== undefined ? starts.or(returns) : undefined,
				keyOf($).neq(""),
				hasPopulationFilter(filters)
					? inSubquery(keyOf($), matchingPersonsSubquery(keyBy, filters))
					: undefined,
			]
		})

	const perKey = fromQuery(rows, "retention_events")
		.select(($) => ({
			key: $.key,
			first: CH.rawExpr<DateTime.Utc>("minIf(ts, isStart = 1)", T.dateTime64),
			buckets: CH.untypedExpr(`groupUniqArrayIf(${bucketOf(interval, "ts")}, isReturn = 1)`),
		}))
		.groupBy("key")

	// A key with no start event has `first` at the epoch, which the window drops.
	const cohorted = fromQuery(perKey, "per_key")
		.select(() => ({
			// The interval's first day, kept as a Date here so the periods are date arithmetic.
			cohortDay: CH.untypedExpr(bucketOf(interval, "first")),
			period: CH.rawExpr<number>(
				`arrayJoin(arrayConcat([0], arrayDistinct(arrayFilter(p -> p >= 1 AND p <= ${opts.periods}, arrayMap(b -> ${periodsBetween(interval, "cohortDay", "b")}, buckets)))))`,
				T.int64,
			),
		}))
		// Half-open: a first event on the instant the window ends belongs to the next interval.
		.where(($) => [$.first.gte(param.dateTime("startTime")), $.first.lt(param.dateTime("endTime"))])

	return Result.succeed(
		fromQuery(cohorted, "cohorted")
			.select(($) => ({
				cohort: CH.rawExpr<string>("toString(cohortDay)", T.string),
				period: $.period,
				count: CH.count(),
			}))
			.groupBy("cohort", "period")
			.orderBy(["cohort", "asc"], ["period", "asc"])
			.format("JSON"),
	)
}
