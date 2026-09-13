// User paths over `product_events`: what people do in the steps after (or
// before) one anchor event.
//
// Per person the events in range are gathered in time order, cut at the anchor
// (the first occurrence going forward, the last going backward), bounded by
// the window, collapsed of consecutive repeats, and truncated to `depth` hops.
// Each hop is one `(hop, fromNode, toNode)` row; a person whose sequence ends
// before `depth` emits a hop into `''` — the chart's "Ended". Only the top
// `branches` nodes per column are named; the rest fold into `$other` on both
// sides of every hop, so the flows a reader sees always add up.
//
// The sequence work is raw SQL over per-person arrays (`arrayFirstIndex`,
// `arrayFilter`, `arrayCompact` with lambdas), which the builder cannot
// express; every column the raw strings name is one the same query projects,
// and every user-supplied value (the anchor, the excluded names) enters through
// a typed condition, never a string.

import * as CH from "@maple-dev/effect-clickhouse/expr"
import { param, from, fromQuery, inSubquery, table } from "@maple-dev/effect-clickhouse"
import type { CHQuery } from "@maple-dev/effect-clickhouse"
import * as T from "@maple-dev/effect-clickhouse/types"
import { Schema } from "effect"
import { ProductEvents } from "../tables"
import { CHNumber } from "../schema"
import {
	LINK_ALIAS,
	ProductEventsFunnelError,
	eventDisplayName,
	eventStepCondition,
	epochMs,
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

export type PathsDirection = "after" | "before"
/** Which rows take part in a sequence: page views, custom events, or both. */
export type PathsInclude = "all" | "events" | "pages"

export type PathsAnchor = Extract<FunnelStep, { kind: "event" | "page" }>

export interface ProductEventsPathsOpts {
	readonly anchor: PathsAnchor
	readonly direction: PathsDirection
	/** Hops away from the anchor to draw, 1..5. */
	readonly depth: number
	/** Named nodes per column; the rest fold into `$other`. 1..10. */
	readonly branches: number
	readonly keyBy: FunnelKeyBy
	/** How far from the anchor a hop may be, in seconds. */
	readonly windowSeconds: number
	readonly include?: PathsInclude
	/** Names (event names / page paths) dropped before sequencing — heartbeats, "/". */
	readonly exclude?: ReadonlyArray<string>
	readonly filters?: ProductEventsFilters
}

export const PATHS_MAX_DEPTH = 5
export const PATHS_MAX_BRANCHES = 10
/** The folded remainder of a column, on the wire. */
export const PATHS_OTHER = "$other"
/** Most events kept per person before sequencing — a bound on the per-person array, not a semantic. */
const PATHS_EVENTS_PER_PERSON = 5000
/** Events kept after the anchor before compaction; well above `depth` so repeats do not eat the tail. */
const PATHS_RAW_TAIL = 200

export const productEventsPathsRowSchema = Schema.Struct({
	/** 1-based: `fromNode` sits in column `hop - 1`, `toNode` in column `hop`. */
	hop: CHNumber,
	fromNode: Schema.String,
	/** `''` when the person's sequence ended here; `$other` for a folded node. */
	toNode: Schema.String,
	count: CHNumber,
})
export type ProductEventsPathsOutput = typeof productEventsPathsRowSchema.Type

function validate(opts: ProductEventsPathsOpts): void {
	if (!Number.isInteger(opts.depth) || opts.depth < 1 || opts.depth > PATHS_MAX_DEPTH) {
		throw new ProductEventsFunnelError({
			reason: "InvalidLimit",
			message: `paths depth must be an integer in 1..${PATHS_MAX_DEPTH}, got ${String(opts.depth)}`,
		})
	}
	if (!Number.isInteger(opts.branches) || opts.branches < 1 || opts.branches > PATHS_MAX_BRANCHES) {
		throw new ProductEventsFunnelError({
			reason: "InvalidLimit",
			message: `paths branches must be an integer in 1..${PATHS_MAX_BRANCHES}, got ${String(opts.branches)}`,
		})
	}
	if (!Number.isFinite(opts.windowSeconds) || opts.windowSeconds <= 0) {
		throw new ProductEventsFunnelError({
			reason: "InvalidWindow",
			message: `windowSeconds must be a positive number, got ${String(opts.windowSeconds)}`,
		})
	}
	const anchorName = opts.anchor.kind === "event" ? opts.anchor.eventName : opts.anchor.pagePath
	if (anchorName.trim() === "") {
		throw new ProductEventsFunnelError({
			reason: "NoSteps",
			message: "paths need an anchor event or page",
		})
	}
}

/** The include filter as a row predicate; `undefined` for "all". */
function includeCondition($: OpenJoinAccessor<typeof ProductEvents.columns>, include: PathsInclude) {
	switch (include) {
		case "all":
			return undefined
		case "events":
			return $.Kind.neq("navigation")
		case "pages":
			return $.Kind.eq("navigation")
	}
}

/**
 * Every qualifying event of every person who has the anchor in range, as
 * `(key, ts, name, isAnchor)`. The anchor semi-join is what keeps the
 * per-person arrays to the persons the chart can draw.
 */
function pathEventsBranch(opts: ProductEventsPathsOpts, filters: ProductEventsFilters) {
	const keyBy = opts.keyBy
	const include = opts.include ?? "all"
	const exclude = opts.exclude ?? []

	const withIdentity = (): OpenJoinQuery<typeof ProductEvents.columns> => {
		const base: OpenJoinQuery<typeof ProductEvents.columns> = from(ProductEvents, "e")
		return keyBy === "person"
			? base.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (e, link) =>
					e.VisitorId.eq(link.VisitorId),
				)
			: base
	}
	const keyOf = ($: OpenJoinAccessor<typeof ProductEvents.columns>) =>
		personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
	const inRange = ($: OpenJoinAccessor<typeof ProductEvents.columns>) => [
		$.OrgId.eq(param.string("orgId")),
		$.Timestamp.gte(param.dateTimeString("startTime")),
		$.Timestamp.lte(param.dateTimeString("endTime")),
		keyOf($).neq(""),
		hasPopulationFilter(filters)
			? inSubquery(keyOf($), matchingPersonsSubquery(keyBy, filters))
			: undefined,
	]

	const anchorPersons = withIdentity()
		.select(($) => ({ key: keyOf($) }))
		.where(($) => [...inRange($), eventStepCondition($, opts.anchor)])
		.groupBy("key")

	return withIdentity()
		.select(($) => ({
			key: keyOf($),
			ts: epochMs($.Timestamp),
			name: eventDisplayName($),
			isAnchor: flag(eventStepCondition($, opts.anchor) ?? CH.rawCond("0")),
		}))
		.where(($) => [
			...inRange($),
			includeCondition($, include),
			exclude.length > 0 ? CH.notInList(eventDisplayName($), exclude) : undefined,
			inSubquery(keyOf($), anchorPersons),
		])
}

/**
 * `{ hop, fromNode, toNode, count }` hops, top `branches` nodes named per column.
 *
 * Rows come back ordered by hop then count; `hop` runs 1..depth
 * whichever the direction — the reader flips the columns for `before`.
 */
export function productEventsPathsQuery(
	opts: ProductEventsPathsOpts,
): CHQuery<any, ProductEventsPathsOutput, any> {
	validate(opts)
	const filters = opts.filters ?? {}
	const windowMs = opts.windowSeconds * 1000
	const forward = opts.direction === "after"

	// Per person: the sorted `(ts, name, isAnchor)` tuples — reversed for a
	// backward walk so "first anchor, then onward" reads the same either way.
	const ordered = forward ? "evs" : "arrayReverse(evs)"
	const windowCond = forward ? `x.1 <= anchorTs + ${windowMs}` : `x.1 >= anchorTs - ${windowMs}`

	const perPerson = fromQuery(pathEventsBranch(opts, filters), "path_events")
		.select(($) => ({
			key: $.key,
			evs: CH.untypedExpr<unknown>(
				`arraySort(x -> x.1, groupArray(${PATHS_EVENTS_PER_PERSON})(tuple(ts, name, isAnchor)))`,
			),
		}))
		.groupBy("key")

	const sequences = fromQuery(perPerson, "per_person")
		.select(($) => ({
			key: $.key,
			anchorIdx: CH.rawExpr<number>(`arrayFirstIndex(x -> x.3 = 1, ${ordered})`, T.uint32),
			anchorTs: CH.rawExpr<number>(`tupleElement(arrayElement(${ordered}, anchorIdx), 1)`, T.uint64),
			seq: CH.rawExpr<ReadonlyArray<string>>(
				`arraySlice(arrayCompact(arrayMap(x -> x.2, arrayFilter(x -> ${windowCond}, arraySlice(${ordered}, anchorIdx, ${PATHS_RAW_TAIL})))), 1, ${opts.depth + 1})`,
				T.array(T.string),
			),
		}))
		.where(() => [CH.rawCond("anchorIdx > 0")])

	// One row per hop. `toNode = ''` when the sequence ends inside `depth`; the hop
	// out of the last drawn column is not emitted, since the person may well
	// have gone on.
	const edges = fromQuery(sequences, "sequences").select(($) => ({
		key: $.key,
		edge: CH.untypedExpr<unknown>(
			`arrayJoin(arrayMap(i -> tuple(i, arrayElement(seq, i), if(i < length(seq), arrayElement(seq, i + 1), '')), arrayEnumerate(seq)))`,
		),
	}))
	const flatQuery = fromQuery(edges, "edges")
		.select(($) => ({
			key: $.key,
			hop: CH.rawExpr<number>("tupleElement(edge, 1)", T.uint32),
			fromNode: CH.rawExpr<string>("tupleElement(edge, 2)", T.string),
			toNode: CH.rawExpr<string>("tupleElement(edge, 3)", T.string),
		}))
		.where(() => [CH.rawCond(`tupleElement(edge, 1) <= ${opts.depth}`)])
	// The hop rows are read three times below (ranking, and both sides of the
	// mapping join); a CTE evaluates the per-person sequencing once.
	const flat = table("path_hops", {
		key: T.string,
		hop: T.uint32,
		fromNode: T.string,
		toNode: T.string,
	})

	// The named nodes: per column (a `toNode` at `hop`), the `branches` most
	// visited. Ranked with a per-column array head rather than `LIMIT BY`.
	const nodeCounts = from(flat)
		.select(($) => ({ hop: $.hop, name: $.toNode, n: CH.count() }))
		.where(($) => [$.toNode.neq("")])
		.groupBy("hop", "name")
	const ranked = fromQuery(nodeCounts, "node_counts")
		.select(($) => ({
			hop: $.hop,
			head: CH.untypedExpr<unknown>(
				`arraySlice(arrayReverseSort(x -> x.2, groupArray(tuple(name, n))), 1, ${opts.branches})`,
			),
		}))
		.groupBy("hop")
	const keptEntries = fromQuery(ranked, "ranked").select(($) => ({
		hop: $.hop,
		entry: CH.untypedExpr<unknown>("arrayJoin(head)"),
	}))
	const kept = fromQuery(keptEntries, "kept_entries").select(($) => ({
		hop: $.hop,
		// The hop this node's OUTGOING edges sit at, so an edge's `fromNode` joins on it.
		nextHop: ($.hop as CH.Expr<number>).add(1),
		name: CH.rawExpr<string>("tupleElement(entry, 1)", T.string),
	}))

	const mapped = from(flat, "h")
		.withCTE("path_hops", flatQuery)
		.leftJoinQuery(kept, "kf", (h, kf) => h.hop.eq(kf.nextHop).and(h.fromNode.eq(kf.name)))
		.leftJoinQuery(kept, "kt", (h, kt) => h.hop.eq(kt.hop).and(h.toNode.eq(kt.name)))
		.select(($) => {
			const hop = $.hop as CH.Expr<number>
			const fromName = $.fromNode as CH.Expr<string>
			const toName = $.toNode as CH.Expr<string>
			const keptFrom = CH.coalesce($.kf.name as CH.Expr<string | null>, CH.lit(""))
			const keptTo = CH.coalesce($.kt.name as CH.Expr<string | null>, CH.lit(""))
			return {
				hop,
				// Column 0 is the anchor alone, so a first hop's `fromNode` is always named.
				fromNode: CH.multiIf(
					[
						[hop.eq(1), fromName],
						[keptFrom.neq(""), fromName],
					],
					CH.lit(PATHS_OTHER),
				),
				toNode: CH.multiIf(
					[
						[toName.eq(""), CH.lit("")],
						[keptTo.neq(""), toName],
					],
					CH.lit(PATHS_OTHER),
				),
				count: CH.count(),
			}
		})
		.groupBy("hop", "fromNode", "toNode")

	return fromQuery(mapped, "mapped")
		.select(($) => ({ hop: $.hop, fromNode: $.fromNode, toNode: $.toNode, count: $.count }))
		.orderBy(["hop", "asc"], ["count", "desc"], ["fromNode", "asc"], ["toNode", "asc"])
		.format("JSON")
}
