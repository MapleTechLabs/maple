// Cohorts over `product_events`: the keys that did one thing and, optionally, did not do another.
//
// "Who exported a report this month", "which users created a workspace and never a project",
// "which accounts started checkout and did not pay". One pass per key over the rows matching
// either event; the listing and both totals come back from the same read.

import * as CH from "@maple-dev/effect-orm/expr"
import { param, from, fromQuery } from "@maple-dev/effect-orm/clickhouse"
import type { CHQuery, ColumnDefs } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import { type DateTime, Result, Schema } from "effect"
import * as Datasources from "@maple/domain/tinybird/datasources"
import type { AttributeFilter } from "@maple/domain/query-engine"
import { orgIdParam } from "../tables"
import { CHNumber } from "../schema"
import {
	LINK_ALIAS,
	eventStepCondition,
	flag,
	identityLinksByVisitor,
	personKey,
	personPropertyConditions,
	type OpenJoinAccessor,
	type OpenJoinQuery,
} from "./product-events"
import type { RetentionKeyBy, RetentionStep } from "./product-events-retention"

export const COHORT_MAX_MEMBERS = 500

export interface ProductEventsCohortOpts {
	/** What a member did, inside the window. */
	readonly did: RetentionStep
	/** What a member did not do. */
	readonly didNot?: RetentionStep
	/**
	 * Over what `didNot` is read: `ever` is the table's whole history up to the window's end
	 * ("never"), `window` the window alone ("not in this period").
	 */
	readonly didNotScope: "ever" | "window"
	readonly keyBy: RetentionKeyBy
	/** Members listed, latest first, 1..500. The totals count all of them. */
	readonly limit: number
	/** User and account property filters, as a funnel takes them (`personPropertyConditions`). */
	readonly userPropertyFilters?: ReadonlyArray<AttributeFilter>
	readonly groupPropertyFilters?: ReadonlyArray<AttributeFilter>
}

export const productEventsCohortRowSchema = Schema.Struct({
	key: Schema.String,
	/** The member's first and last `did` event in the window. */
	firstAt: Schema.String,
	lastAt: Schema.String,
	/** How often the member did it in the window. */
	count: CHNumber,
	/** Every key that did it in the window, excluded or not: the same on every row. */
	didTotal: CHNumber,
	/** The members: those of `didTotal` that did not do `didNot`. The same on every row. */
	total: CHNumber,
})
export type ProductEventsCohortOutput = typeof productEventsCohortRowSchema.Type

/** A cohort definition the builder cannot compile; returned as a `Result` failure. */
export class ProductEventsCohortError extends Schema.TaggedError<ProductEventsCohortError>()(
	"@maple/query-engine/ProductEventsCohortError",
	{
		reason: Schema.Literals(["InvalidLimit"]),
		message: Schema.String,
	},
) {}

type EventsColumns = typeof Datasources.productEvents.columns

/**
 * `{ key, firstAt, lastAt, count, didTotal, total }`, the member who did it last first. No rows
 * when nobody is a member, so a caller that needs `didTotal` for an empty cohort reads 0 for both.
 */
export function productEventsCohortQuery(
	opts: ProductEventsCohortOpts,
): Result.Result<CHQuery<ColumnDefs, ProductEventsCohortOutput>, ProductEventsCohortError> {
	if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > COHORT_MAX_MEMBERS) {
		return Result.fail(
			new ProductEventsCohortError({
				reason: "InvalidLimit",
				message: `limit must be an integer in 1..${COHORT_MAX_MEMBERS}, got ${String(opts.limit)}`,
			}),
		)
	}
	const { keyBy } = opts
	const events: OpenJoinQuery<EventsColumns> = from(Datasources.productEvents, "e")
	const withIdentity =
		keyBy === "person"
			? events.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (e, link) =>
					e.VisitorId.eq(link.VisitorId),
				)
			: events
	const keyOf = ($: OpenJoinAccessor<EventsColumns>) =>
		personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
	// `ever` has to see a `didNot` from before the window, so only then is the read unbounded below.
	const readsHistory = opts.didNot !== undefined && opts.didNotScope === "ever"

	const rows = withIdentity
		.select(($) => {
			const did = eventStepCondition($, opts.did) ?? CH.rawCond("0")
			const didNot = opts.didNot === undefined ? undefined : eventStepCondition($, opts.didNot)
			return {
				key: keyOf($),
				ts: $.Timestamp,
				isDid: flag(did.and($.Timestamp.gte(param.dateTime("startTime")))),
				isNot: didNot === undefined ? CH.lit(0) : flag(didNot),
			}
		})
		.where(($) => {
			const did = eventStepCondition($, opts.did) ?? CH.rawCond("0")
			const didNot = opts.didNot === undefined ? undefined : eventStepCondition($, opts.didNot)
			return [
				$.OrgId.eq(orgIdParam),
				$.Timestamp.lte(param.dateTime("endTime")),
				readsHistory ? undefined : $.Timestamp.gte(param.dateTime("startTime")),
				didNot === undefined ? did : did.or(didNot),
				keyOf($).neq(""),
				...personPropertyConditions(keyBy, keyOf($), opts),
			]
		})

	const perKey = fromQuery(rows, "cohort_events")
		.select(($) => ({
			key: $.key,
			firstAt: CH.rawExpr<DateTime.Utc>("minIf(ts, isDid = 1)", T.dateTime64),
			lastAt: CH.rawExpr<DateTime.Utc>("maxIf(ts, isDid = 1)", T.dateTime64),
			didCount: CH.rawExpr<number>("countIf(isDid = 1)", T.uint64),
			notCount: CH.rawExpr<number>("countIf(isNot = 1)", T.uint64),
		}))
		.groupBy("key")

	// Both totals are window functions over every key that did it, read before the exclusion
	// and the limit cut the rows down.
	const counted = fromQuery(perKey, "per_key")
		.select(($) => ({
			key: $.key,
			firstAt: $.firstAt,
			lastAt: $.lastAt,
			didCount: $.didCount,
			notCount: $.notCount,
			didTotal: CH.rawExpr<number>("count() OVER ()", T.uint64),
			total: CH.rawExpr<number>("countIf(notCount = 0) OVER ()", T.uint64),
		}))
		.where(($) => [$.didCount.gt(0)])

	return Result.succeed(
		fromQuery(counted, "counted")
			.select(($) => ({
				// Typed here: a key passed up through three subqueries has lost its type on the way.
				key: CH.dynamicColumn("key", T.string),
				firstAt: CH.toString_($.firstAt),
				lastAt: CH.toString_($.lastAt),
				count: $.didCount,
				didTotal: $.didTotal,
				total: $.total,
			}))
			.where(($) => [$.notCount.eq(0)])
			.orderBy(["lastAt", "desc"], ["key", "asc"])
			.limit(opts.limit)
			.format("JSON"),
	)
}
