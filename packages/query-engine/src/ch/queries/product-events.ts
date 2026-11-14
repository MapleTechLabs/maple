// Product events — funnels over `product_events`.
//
// `product_events` is the one time-sorted table every product event lands in:
// browser page views and `track()` calls via the `session_events` MV, backend
// and mobile events via `POST /v1/events`. Funnels step over it per person, in
// `orderKey` order (docs/product-events-funnels.md), and every query here keeps the
// page-level filter surface (`ProductEventsFilters`) so the `/analytics`
// sidebar narrows a funnel exactly the way it narrows the page-view panels.
//
// The page-view queries themselves live in `web-analytics.ts` and read the
// same table (`useProductEvents`); this module owns everything funnel-shaped.

import * as CH from "@maple-dev/effect-orm/expr"
import { FUNNEL_MAX_STEPS } from "@maple/query-model"
import {
	param,
	from,
	fromQuery,
	fromUnion,
	unionAll,
	inSubquery,
	compileFnCall,
} from "@maple-dev/effect-orm/clickhouse"
import type {
	CHQuery,
	ColumnAccessor,
	ColumnDefs,
	JoinedColumnAccessor,
} from "@maple-dev/effect-orm/clickhouse"
import { type DateTime, Result, Schema, Array as Arr, Record as Rec, String as Str, Option } from "effect"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam } from "../tables"
import { CHNumber } from "../schema"
import { replaysWhere, needsSessionSemiJoin, type ProductEventsFilters } from "./web-analytics"
import * as T from "@maple-dev/effect-orm/clickhouse"

export type { ProductEventsFilters } from "./web-analytics"

// Local function helpers (generic per call site, so not `defineFn`)

// `arrayElement` comes from the builder — it reads the array's element type, so
// a funnel step decodes as the count it is.

// toUInt8(cond) — a condition as a projectable 0/1 column.
export function flag(cond: CH.Condition): CH.Expr<number> {
	return CH.compileTypedFnCall("toUInt8", T.uint8.schema, cond)
}

// toUInt64(toUnixTimestamp64Milli(ts)) — `windowFunnel` accepts Date, DateTime
// and unsigned integers but NOT DateTime64, so both branches carry their
// timestamp as epoch milliseconds and the window is `windowSeconds * 1000`.
// Milliseconds rather than `toDateTime()` so two events in the same second
// (page load → track()) keep their real order instead of tying.
export function epochMs(ts: CH.Expr<DateTime.Utc>): CH.Expr<number> {
	return CH.toUInt64(compileFnCall<number>("toUnixTimestamp64Milli", ts))
}

/** How many {@link orderKey} units one millisecond spans. */
const ORDER_UNITS_PER_MS = 1_024_000

/**
 * A row's place in its person's history, as one unsigned integer: microseconds * 1024 +
 * (`Seq` % 1024). `Seq` is the tiebreak inside one timestamp (a page load and the `track()` it
 * fires share a millisecond), and server rows, which carry `Seq` 0, order by their own clock.
 * `windowFunnel` and the chain walk both read this key, so they cannot disagree about order.
 */
function orderKey(ts: CH.Expr<DateTime.Utc>, seq: CH.Expr<number>): CH.Expr<number> {
	const micros = CH.toUInt64(compileFnCall<number>("toUnixTimestamp64Micro", ts))
	return CH.compileTypedFnCall(
		"plus",
		T.uint64.schema,
		CH.compileTypedFnCall("multiply", T.uint64.schema, micros, CH.lit(1024)),
		CH.compileTypedFnCall("modulo", T.uint64.schema, seq, CH.lit(1024)),
	)
}

// argMinIf(value, orderBy, cond) — the `value` on the earliest row matching
// `cond`. Returns one of its inputs unchanged, so it decodes as that input does.
export function argMinIf<T>(value: CH.Expr<T>, orderBy: CH.Expr<unknown>, cond: CH.Condition): CH.Expr<T> {
	return CH.compileTypedFnCall("argMinIf", CH.schemaOf<T>(value), value, orderBy, cond)
}

// Every UNION ALL branch below is built from a different table, and the shape
// they share is this. `unionAll`'s type unification cannot see through the
// per-branch `select` callbacks (each infers its own literal type), so the
// branches are annotated to it explicitly.
type FunnelEventRow = { readonly [column: string]: unknown }
type FunnelBranch = CHQuery<ColumnDefs, FunnelEventRow, Record<string, ColumnDefs>>

/** Which `session_replays` dimension a `session` step (or a breakdown) reads. */
export type FunnelSessionDimension =
	| "referrerHost"
	| "utmSource"
	| "utmMedium"
	| "utmCampaign"
	| "country"
	| "host"

/**
 * One funnel step.
 *
 * - `event`: a `track()` (or direct-ingested) event by name, optionally
 *   narrowed by `Attributes[k] = v` for every entry of `attributeEquals`.
 * - `page`: a browser page view or a mobile screen view of `pagePath`, optionally
 *   on one `host`.
 * - `session`: "started a session with this acquisition dimension" — the
 *   referral / campaign entry point. Only valid as step 1: it is evaluated
 *   against `session_replays` and enters the funnel as a synthetic
 *   `$session_entry` event at the session's `StartTime`.
 */
export type FunnelStep =
	| {
			readonly kind: "event"
			readonly eventName: string
			readonly attributeEquals?: Readonly<Record<string, string>>
	  }
	| { readonly kind: "page"; readonly pagePath: string; readonly host?: string }
	| { readonly kind: "session"; readonly dimension: FunnelSessionDimension; readonly value: string }

/**
 * What a funnel counts.
 *
 * - `person`: `UserId` when the row carries one, else the `VisitorId`'s linked
 *   user from `identity_links`, else the `VisitorId` — so an anonymous marketing
 *   visit and the same person's post-signup (or server-side) events collapse
 *   into one person.
 * - `visitor` / `user`: the raw column, non-empty.
 * - `session`: `SessionId` — a per-session funnel; server events (no session)
 *   never take part.
 */
export type FunnelKeyBy = "person" | "visitor" | "user" | "session"

export interface ProductEventsFunnelOpts {
	/** 1–10 steps, in order. A `session` step may only appear first. */
	readonly steps: ReadonlyArray<FunnelStep>
	readonly keyBy: FunnelKeyBy
	/** The whole chain must complete within this many seconds of the step-1 event. */
	readonly windowSeconds: number
	/** Sidebar filters — narrow the *population* to persons with a matching session. */
	readonly filters?: ProductEventsFilters
}

/**
 * How a breakdown groups persons: an acquisition dimension of the person's
 * sessions, the event `Host`, or `Attributes[<key>]` on the person's events.
 * In every case the group is the first non-empty value seen for that person.
 */
export type FunnelBreakdownBy = FunnelSessionDimension | `attribute:${string}`

export interface ProductEventsFunnelBreakdownOpts extends ProductEventsFunnelOpts {
	readonly breakdownBy: FunnelBreakdownBy
	/** Groups to keep, ranked by step-1 count. Default 10, max 20. */
	readonly limit?: number
}

export interface ProductEventNamesOpts {
	readonly filters?: ProductEventsFilters
	/** Default 100. */
	readonly limit?: number
}

export const productEventsFunnelRowSchema = Schema.Struct({
	step: CHNumber,
	count: CHNumber,
})
export type ProductEventsFunnelOutput = typeof productEventsFunnelRowSchema.Type

export const productEventsFunnelBreakdownRowSchema = Schema.Struct({
	group: Schema.String,
	step: CHNumber,
	count: CHNumber,
})
export type ProductEventsFunnelBreakdownOutput = typeof productEventsFunnelBreakdownRowSchema.Type

export const productEventNamesRowSchema = Schema.Struct({
	eventName: Schema.String,
	kind: Schema.String,
	count: CHNumber,
	sessions: CHNumber,
	persons: CHNumber,
})
export type ProductEventNamesOutput = typeof productEventNamesRowSchema.Type

/** A funnel definition the builder cannot compile; the builders return it as a `Result` failure. */
export class ProductEventsFunnelError extends Schema.TaggedError<ProductEventsFunnelError>()(
	"@maple/query-engine/ProductEventsFunnelError",
	{
		reason: Schema.Literals([
			"NoSteps",
			"TooManySteps",
			"SessionStepNotFirst",
			"InvalidWindow",
			"InvalidLimit",
			"TooFewSteps",
		]),
		message: Schema.String,
	},
) {}

export const FUNNEL_BREAKDOWN_MAX_GROUPS = 20

function validate(opts: ProductEventsFunnelOpts): ProductEventsFunnelError | undefined {
	if (opts.steps.length === 0) {
		return new ProductEventsFunnelError({
			reason: "NoSteps",
			message: "a funnel needs at least one step",
		})
	}
	if (opts.steps.length > FUNNEL_MAX_STEPS) {
		return new ProductEventsFunnelError({
			reason: "TooManySteps",
			message: `a funnel has at most ${FUNNEL_MAX_STEPS} steps, got ${opts.steps.length}`,
		})
	}
	const misplacedSession = Arr.findFirstIndex(
		opts.steps,
		(step, index) => step.kind === "session" && index !== 0,
	)
	if (Option.isSome(misplacedSession)) {
		return new ProductEventsFunnelError({
			reason: "SessionStepNotFirst",
			message: `a session step is only valid as step 1, found one at step ${misplacedSession.value + 1}`,
		})
	}
	if (!Number.isFinite(opts.windowSeconds) || opts.windowSeconds <= 0) {
		return new ProductEventsFunnelError({
			reason: "InvalidWindow",
			message: `windowSeconds must be a positive number, got ${String(opts.windowSeconds)}`,
		})
	}
	return undefined
}

export type EventsAccessor = ColumnAccessor<typeof Datasources.productEvents.columns>
type ReplaysAccessor = ColumnAccessor<typeof Datasources.sessionReplays.columns>
type IdentityAccessor = {
	readonly SessionId: CH.Expr<string>
	readonly VisitorId: CH.Expr<string>
	readonly UserId: CH.Expr<string>
}
// The `identity_links` join alias — a typed accessor when the join is declared
// statically, an open one under `OpenJoinQuery`.
type LinkAccessor = { readonly UserId: CH.Expr<string | null> } | ColumnAccessor<ColumnDefs>

export const LINK_ALIAS = "link"

/**
 * `identity_links` collapsed to one linked user per visitor: the user the
 * visitor became *first*, which is the identity that anonymous rows
 * chronologically precede — the one a conversion funnel wants.
 *
 * TWO aggregations, and the inner one is load-bearing. `identity_links` holds
 * one row per (visitor, user) SIGHTING until a merge collapses them, so a pair
 * seen across several sessions has several rows with different `FirstSeen`.
 * `min(FirstSeen)` per pair reduces that to the pair's first sighting, and only
 * then does the outer `argMin` pick which user the visitor became first.
 *
 * The engine is the other half of this: `identity_links` is an
 * AggregatingMergeTree whose `FirstSeen` collapses under `min`, so the merge
 * keeps that same earliest value. A plain ReplacingMergeTree (no version
 * column) keeps an arbitrary duplicate instead — usually the newest — and no
 * amount of read-time aggregation recovers the row it dropped, so a visitor
 * linked to A in January and again in March, and to B in February, would answer
 * "A" until the merge landed and "B" after. Neither half works alone.
 */
export function identityLinksByVisitor() {
	const firstSeenPerPair = from(Datasources.identityLinks)
		.select(($) => ({
			VisitorId: $.VisitorId,
			UserId: $.UserId,
			FirstSeen: CH.min_($.FirstSeen),
		}))
		.where(($) => [$.OrgId.eq(orgIdParam)])
		.groupBy("VisitorId", "UserId")

	return fromQuery(firstSeenPerPair, "pair_links")
		.select(($) => ({ VisitorId: $.VisitorId, UserId: CH.argMin($.UserId, $.FirstSeen) }))
		.groupBy("VisitorId")
}

/** The person key for one row, per {@link FunnelKeyBy}. `link` is set only for `person`. */
export function personKey(keyBy: FunnelKeyBy, $: IdentityAccessor, link?: LinkAccessor): CH.Expr<string> {
	switch (keyBy) {
		case "session":
			return $.SessionId
		case "visitor":
			return $.VisitorId
		case "user":
			return $.UserId
		case "person": {
			// join_use_nulls=0 (the default) yields '' for an unmatched LEFT JOIN;
			// coalesce covers a cluster that flips it on and yields NULL instead.
			const linked = link ? compileFnCall<string>("coalesce", link.UserId, CH.lit("")) : CH.lit("")
			return CH.multiIf(
				[
					[$.UserId.neq(""), $.UserId],
					[linked.neq(""), linked],
				],
				$.VisitorId,
			)
		}
	}
}

/** Column of `session_replays` behind a session dimension. */
function sessionDimensionColumn($: ReplaysAccessor, dimension: FunnelSessionDimension): CH.Expr<string> {
	switch (dimension) {
		case "referrerHost":
			return $.ReferrerHost
		case "utmSource":
			return $.UtmSource
		case "utmMedium":
			return $.UtmMedium
		case "utmCampaign":
			return $.UtmCampaign
		case "country":
			return $.Country
		case "host":
			return $.Host
	}
}

/** A browser page view or a mobile screen view: both are named by `PagePath`. */
function isPageView(
	$: EventsAccessor | OpenJoinAccessor<typeof Datasources.productEvents.columns>,
): CH.Condition {
	return CH.inList($.Kind, ["navigation", "screen"])
}

/** The step's predicate over a `product_events` row. `session` steps never match an event row. */
export function eventStepCondition($: EventsAccessor, step: FunnelStep): CH.Condition | undefined {
	switch (step.kind) {
		case "event": {
			let cond = $.EventName.eq(step.eventName)
			for (const [key, value] of Rec.toEntries(step.attributeEquals ?? {})) {
				cond = cond.and($.Attributes.get(key).eq(value))
			}
			return cond
		}
		case "page": {
			const cond = isPageView($).and($.PagePath.eq(step.pagePath))
			return step.host === undefined ? cond : cond.and($.Host.eq(step.host))
		}
		case "session":
			return undefined
	}
}

/** True when any sidebar filter is set — i.e. the population must be narrowed. */
export function hasPopulationFilter(filters: ProductEventsFilters): boolean {
	return needsSessionSemiJoin(filters) || filters.host !== undefined || filters.pagePath !== undefined
}

/**
 * `SELECT key FROM session_replays WHERE <sidebar filters>` — the persons whose
 * sessions match the filters, under the same key resolution as the events.
 *
 * Person-level rather than `SessionId IN (…)` on purpose: server-side rows have
 * no `SessionId`, so a session semi-join would silently drop every backend
 * step the moment a filter is active. `host` / `pagePath` reach here through
 * `replaysWhere`'s navigation semi-join, which reads `product_events` — funnels
 * require that table anyway.
 */
export function matchingPersonsSubquery(keyBy: FunnelKeyBy, filters: ProductEventsFilters) {
	const scoped = { ...filters, useProductEvents: true }
	if (keyBy === "person") {
		return from(Datasources.sessionReplays, "s")
			.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (s, link) => s.VisitorId.eq(link.VisitorId))
			.select(($) => ({ key: personKey(keyBy, $, $[LINK_ALIAS]) }))
			.where(($) => replaysWhere($, scoped))
			.groupBy("key")
	}
	return from(Datasources.sessionReplays)
		.select(($) => ({ key: personKey(keyBy, $) }))
		.where(($) => replaysWhere($, scoped))
		.groupBy("key")
}

const stepColumn = (index: number) => `s${index + 1}`

/** `{ s1: …, s2: …, … }` — one projected flag column per step, in order. */
function stepFlags(
	steps: ReadonlyArray<FunnelStep>,
	value: (step: FunnelStep, index: number) => CH.Expr<number>,
): Record<string, CH.Expr<number>> {
	return Rec.fromEntries(Arr.map(steps, (step, index) => [stepColumn(index), value(step, index)]))
}

/**
 * A query over `Cols` whose join map is left open. The branch builders attach
 * joins conditionally (identity links for `person`, session dimensions for a
 * breakdown), so the joined shape is not one static type; under an open map an
 * alias resolves to untyped column refs and the builder only reads the aliases
 * it declared. The `Output` is `{}` because `select` is the last call.
 */
export type OpenJoinQuery<Cols extends ColumnDefs> = CHQuery<Cols, {}, Record<string, ColumnDefs>>
export type OpenJoinAccessor<Cols extends ColumnDefs> = JoinedColumnAccessor<Cols, Record<string, ColumnDefs>>

interface FunnelPlan {
	readonly opts: ProductEventsFunnelOpts
	readonly filters: ProductEventsFilters
	readonly sessionStep: Extract<FunnelStep, { kind: "session" }> | undefined
	/** Set when a breakdown wants a per-row dimension projected as `dim`. */
	readonly breakdownBy?: FunnelBreakdownBy
}

/**
 * The events branch: every `product_events` row in range that matches at least
 * one step, projected to `(key, ts, s1..sN[, dim])`.
 *
 * Only rows matching *some* step are read — a funnel over three events does not
 * scan every page view in the range. The step flags are computed here so the
 * aggregate layer never sees `EventName`/`PagePath`/`Attributes` at all.
 */
function eventsBranch(plan: FunnelPlan): FunnelBranch {
	const { opts, filters, breakdownBy } = plan
	const keyBy = opts.keyBy
	const dim = breakdownBy
	// `host` is a session dimension too, but product_events carries it on every
	// browser row, so it is read there rather than joined in.
	const sessionDimension =
		dim !== undefined && !Str.startsWith("attribute:")(dim) && dim !== "host"
			? (dim as FunnelSessionDimension)
			: undefined

	// Per-session acquisition dimension for a session-dimension breakdown.
	// `max()` so the v2 row's value beats a v1 row's ''.
	const sessionDims = sessionDimension
		? from(Datasources.sessionReplays)
				.select(($) => ({
					SessionId: $.SessionId,
					Value: CH.max_(sessionDimensionColumn($, sessionDimension)),
				}))
				.where(($) => [
					$.OrgId.eq(orgIdParam),
					$.StartTime.gte(param.dateTime("startTime")),
					$.StartTime.lte(param.dateTime("endTime")),
				])
				.groupBy("SessionId")
		: undefined

	// The joins differ by keyBy/breakdown, so the query is held under an open
	// join map: joined aliases resolve to untyped column refs, and only the
	// aliases actually declared above are ever read.
	let base: OpenJoinQuery<typeof Datasources.productEvents.columns> = from(Datasources.productEvents, "e")
	if (keyBy === "person") {
		base = base.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (e, link) =>
			e.VisitorId.eq(link.VisitorId),
		)
	}
	if (sessionDims) {
		base = base.leftJoinQuery(sessionDims, "sd", (e, sd) => e.SessionId.eq(sd.SessionId))
	}

	const dimExpr = (
		$: OpenJoinAccessor<typeof Datasources.productEvents.columns>,
	): CH.Expr<string> | undefined => {
		if (dim === undefined) return undefined
		if (Str.startsWith("attribute:")(dim)) return $.Attributes.get(Str.slice("attribute:".length)(dim))
		if (dim === "host") return $.Host
		// The session-dimension join is attached only for a session breakdown.
		const sd = $.sd
		return sd === undefined ? undefined : compileFnCall<string>("coalesce", sd.Value, CH.lit(""))
	}

	return base
		.select(($) => {
			const key = personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
			const flags = stepFlags(opts.steps, (step) => {
				const cond = eventStepCondition($, step)
				return cond ? flag(cond) : CH.lit(0)
			})
			const d = dimExpr($)
			const row = { key, ord: orderKey($.Timestamp, $.Seq), ...flags }
			return d ? { ...row, dim: d } : row
		})
		.where(($) => {
			const key = personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
			const stepConditions = Arr.filter(
				Arr.map(opts.steps, (step) => eventStepCondition($, step)),
				(cond): cond is CH.Condition => cond !== undefined,
			)
			const anyStep = stepConditions.length === 0 ? undefined : CH.or(...stepConditions)
			return [
				$.OrgId.eq(orgIdParam),
				$.Timestamp.gte(param.dateTime("startTime")),
				$.Timestamp.lte(param.dateTime("endTime")),
				anyStep,
				key.neq(""),
				hasPopulationFilter(filters)
					? inSubquery(key, matchingPersonsSubquery(keyBy, filters))
					: undefined,
			]
		})
}

/**
 * The session-entry branch for a `session` step 1: one synthetic
 * `$session_entry` row per matching session at its `StartTime`, with `s1 = 1`
 * and every other step 0. Un-merged v1/v2 rows of one session yield two chain
 * starts at the same instant, which `windowFunnel` treats as one.
 */
function sessionEntryBranch(plan: FunnelPlan, step: Extract<FunnelStep, { kind: "session" }>): FunnelBranch {
	const { opts, filters, breakdownBy } = plan
	const keyBy = opts.keyBy
	const dim = breakdownBy
	const sessionDimension =
		dim !== undefined && !Str.startsWith("attribute:")(dim) ? (dim as FunnelSessionDimension) : undefined

	let base: OpenJoinQuery<typeof Datasources.sessionReplays.columns> = from(Datasources.sessionReplays, "s")
	if (keyBy === "person") {
		base = base.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (s, link) =>
			s.VisitorId.eq(link.VisitorId),
		)
	}

	return base
		.select(($) => {
			const key = personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
			const flags = stepFlags(opts.steps, (_, index) => CH.lit(index === 0 ? 1 : 0))
			// A session entry has no row order of its own; 0 sorts it first inside its timestamp.
			const row = { key, ord: orderKey($.StartTime, CH.lit(0)), ...flags }
			if (dim === undefined) return row
			// An attribute breakdown has no value on a session row; the events
			// branch supplies it. A session dimension is read straight off the row.
			return {
				...row,
				dim: sessionDimension ? sessionDimensionColumn($, sessionDimension) : CH.lit(""),
			}
		})
		.where(($) => {
			const key = personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
			return [
				$.OrgId.eq(orgIdParam),
				$.StartTime.gte(param.dateTime("startTime")),
				$.StartTime.lte(param.dateTime("endTime")),
				sessionDimensionColumn($, step.dimension).eq(step.value),
				key.neq(""),
				hasPopulationFilter(filters)
					? inSubquery(key, matchingPersonsSubquery(keyBy, filters))
					: undefined,
			]
		})
}

/**
 * The rows a funnel reads: every step-matching event, plus one entry row per matching session
 * when step 1 is a session step.
 *
 * A funnel whose ONLY step is a `session` step has no event predicate at all, so
 * the events branch would have nothing to filter on and would read every
 * `product_events` row in range to project `s1..sN` as zeros: rows that can
 * never reach a level. That funnel is answered by the session-entry branch
 * alone, which is the state the step builder is in the moment step 1 becomes a
 * session step, so the branch is dropped rather than scanned.
 */
function funnelSource(plan: FunnelPlan) {
	const hasEventStep = Arr.some(plan.opts.steps, (step) => step.kind !== "session")
	return plan.sessionStep
		? hasEventStep
			? fromUnion(
					unionAll(sessionEntryBranch(plan, plan.sessionStep), eventsBranch(plan)),
					"funnel_events",
				)
			: fromQuery(sessionEntryBranch(plan, plan.sessionStep), "funnel_events")
		: fromQuery(eventsBranch(plan), "funnel_events")
}

/** The conversion window in {@link orderKey} units, exact past 2^53. */
const windowUnits = (opts: ProductEventsFunnelOpts): string =>
	(BigInt(Math.round(opts.windowSeconds * 1000)) * BigInt(ORDER_UNITS_PER_MS)).toString()

/** What a step matches on, ignoring its attribute and host narrowing: two steps sharing it can match one row. */
const stepSubject = (step: FunnelStep): string => {
	switch (step.kind) {
		case "event":
			return `event:${step.eventName}`
		case "page":
			return `page:${step.pagePath}`
		case "session":
			return "session"
	}
}

/** Two steps could be satisfied by the same row, as in a funnel that repeats a step. */
const stepsCanShareRow = (steps: ReadonlyArray<FunnelStep>): boolean =>
	new Set(Arr.map(steps, stepSubject)).size < steps.length

/**
 * `SELECT key, <level> [, first dim AS group] FROM <funnel rows> GROUP BY key`: one row per
 * person with the deepest step they reached in order within the window.
 *
 * The level is `windowFunnel` when every row can serve one step at most. A funnel that repeats a
 * step (`search` then `search`) is different: `windowFunnel` lets a single `search` row satisfy
 * both conditions, and its `strict_once` mode, which forbids that, is quadratic in a person's
 * rows. Those funnels read the level from {@link walkQuery}, where a row advances one step.
 */
function levelsQuery(plan: FunnelPlan) {
	const { opts } = plan
	if (stepsCanShareRow(opts.steps)) {
		return fromQuery(walkQuery(plan), "walked").select(($) => {
			const row = { key: $.key, level: $.level }
			if (plan.breakdownBy === undefined) return row
			// Not `$.group`: the walk projects it only for a breakdown, so it is not on the accessor's type.
			return { ...row, group: CH.dynamicColumn("group", T.string) }
		})
	}
	const conditions = Arr.join(
		Arr.map(opts.steps, (_, index) => `${stepColumn(index)} = 1`),
		", ",
	)
	return funnelSource(plan)
		.select(($) => {
			const row = {
				key: $.key as CH.Expr<string>,
				level: CH.rawExpr<number>(`windowFunnel(${windowUnits(opts)})(ord, ${conditions})`, T.uint8),
			}
			if (plan.breakdownBy === undefined) return row
			const dim = $.dim as CH.Expr<string>
			return { ...row, group: argMinIf(dim, $.ord as CH.Expr<number>, dim.neq("")) }
		})
		.groupBy("key")
}

/**
 * `SELECT key, evs, level, reachedAt [, group]`: each person's funnel rows as one sorted array,
 * how deep they got, and the order key at which they first got there.
 *
 * It is `windowFunnel`'s own bookkeeping, one step at a time over the whole array so the engine
 * vectorizes it. `aK[i]` is the start of the latest attempt that has reached step K by row `i`;
 * `bK[i]` is that start on the rows that moved an attempt onto step K, else 0. A row reads the
 * state from before it (`aK` shifted by one), so it moves an attempt one step and never two.
 *
 * Raw SQL, because the builder has no lambdas; every name it uses is a column projected here.
 * Tuple element 1 is `ord`, element k + 1 is step k's flag.
 */
function walkQuery(plan: FunnelPlan) {
	const { opts } = plan
	const n = opts.steps.length
	const window = windowUnits(opts)
	const flags = Arr.join(
		Arr.map(opts.steps, (_, index) => stepColumn(index)),
		", ",
	)
	const perPerson = funnelSource(plan)
		.select(($) => {
			const row = {
				key: $.key as CH.Expr<string>,
				// Tuples sort by their first element, the order key.
				evs: CH.untypedExpr(`arraySort(groupArray(tuple(ord, ${flags})))`),
			}
			if (plan.breakdownBy === undefined) return row
			const dim = $.dim as CH.Expr<string>
			return { ...row, group: argMinIf(dim, $.ord as CH.Expr<number>, dim.neq("")) }
		})
		.groupBy("key")

	const later = Arr.makeBy(n - 1, (index) => index + 2)
	const firsts = Arr.makeBy(n, (index) => `f${index + 1}`)
	return fromQuery(perPerson, "person_events").select(($) => {
		const row = {
			key: $.key,
			evs: $.evs,
			a1: CH.untypedExpr("arrayFill(v -> v > 0, arrayMap(x -> if(x.2 = 1, x.1, toUInt64(0)), evs))"),
			...Rec.fromEntries(
				Arr.flatMap(later, (step) => [
					[
						`b${step}`,
						CH.untypedExpr(
							`arrayMap((x, p) -> if(x.${step + 1} = 1 AND p > 0 AND x.1 <= p + ${window}, p, toUInt64(0)), evs, arrayPushFront(arrayPopBack(a${step - 1}), toUInt64(0)))`,
						),
					],
					[`a${step}`, CH.untypedExpr(`arrayFill(v -> v > 0, b${step})`)],
				]),
			),
			f1: CH.untypedExpr("arrayFirst(v -> v > 0, a1)"),
			...Rec.fromEntries(
				Arr.map(later, (step) => [
					`f${step}`,
					CH.untypedExpr(`tupleElement(arrayFirst((x, b) -> b > 0, evs, b${step}), 1)`),
				]),
			),
			level: CH.rawExpr<number>(
				Arr.join(
					Arr.map(firsts, (column) => `(${column} > 0)`),
					" + ",
				),
				T.uint16,
			),
			// Steps are reached in order, so the deepest one's first time is the largest.
			reachedAt: CH.rawExpr<number>(n === 1 ? "f1" : `greatest(${Arr.join(firsts, ", ")})`, T.uint64),
		}
		if (plan.breakdownBy === undefined) return row
		return { ...row, group: CH.dynamicColumn("group", T.string) }
	})
}

/** `[countIf(level >= 1), …, countIf(level >= N)]` over a levels row set. */
function stepCounts(stepCount: number): CH.Expr<ReadonlyArray<number>> {
	const level = CH.dynamicColumn<number>("level")
	return CH.arrayOf(...Array.from({ length: stepCount }, (_, i) => CH.countIf(level.gte(i + 1))))
}

/** `arrayJoin([1, …, N])` — one output row per step. */
function stepIndex(stepCount: number): CH.Expr<number> {
	return CH.arrayJoin(CH.arrayOf(...Array.from({ length: stepCount }, (_, i) => CH.lit(i + 1))))
}

/**
 * Per-step funnel counts: how many persons (per `keyBy`) reached at least step
 * `n`, in order, within `windowSeconds` of their step-1 event.
 *
 * Always returns exactly `steps.length` rows, `step` 1..N ascending, so an
 * empty range decodes as a row of zeros per step rather than as no rows.
 * Conversion rates are the caller's division — the numbers here are the
 * counts the UI shows next to them.
 */
export function productEventsFunnelQuery(
	opts: ProductEventsFunnelOpts,
): Result.Result<CHQuery<ColumnDefs, ProductEventsFunnelOutput>, ProductEventsFunnelError> {
	const invalid = validate(opts)
	if (invalid !== undefined) return Result.fail(invalid)
	const filters = opts.filters ?? {}
	const first = opts.steps[0]
	const plan: FunnelPlan = {
		opts,
		filters,
		sessionStep: first?.kind === "session" ? first : undefined,
	}
	const n = opts.steps.length

	const totals = fromQuery(levelsQuery(plan), "levels").select(() => ({ counts: stepCounts(n) }))

	return Result.succeed(
		fromQuery(totals, "totals")
			.select(($) => ({
				step: stepIndex(n),
				count: CH.arrayElement($.counts, CH.dynamicColumn<number>("step")),
			}))
			.orderBy(["step", "asc"])
			.format("JSON"),
	)
}

/**
 * The same funnel, split by one dimension: `{ group, step, count }` for the top
 * `limit` groups by step-1 count. Every kept group emits all N steps.
 *
 * A person's group is the first non-empty value of the dimension across their
 * rows in range (`argMinIf(dim, ts, dim != '')`) — for a session dimension that
 * is their earliest session's referrer / campaign / country, for `host` the
 * first host they were seen on, for `attribute:<k>` the first event carrying
 * it. Persons with no value at all land in the `''` group, which the caller
 * may label or drop.
 *
 * Rows come back ordered by `group`, then `step`; the step-1 row of each group
 * carries the rank the `limit` was applied on.
 */
export function productEventsFunnelBreakdownQuery(
	opts: ProductEventsFunnelBreakdownOpts,
): Result.Result<CHQuery<ColumnDefs, ProductEventsFunnelBreakdownOutput>, ProductEventsFunnelError> {
	const invalid = validate(opts)
	if (invalid !== undefined) return Result.fail(invalid)
	const limit = opts.limit ?? 10
	if (!Number.isInteger(limit) || limit < 1 || limit > FUNNEL_BREAKDOWN_MAX_GROUPS) {
		return Result.fail(
			new ProductEventsFunnelError({
				reason: "InvalidLimit",
				message: `breakdown limit must be an integer in 1..${FUNNEL_BREAKDOWN_MAX_GROUPS}, got ${String(limit)}`,
			}),
		)
	}
	const filters = opts.filters ?? {}
	const first = opts.steps[0]
	const plan: FunnelPlan = {
		opts,
		filters,
		sessionStep: first?.kind === "session" ? first : undefined,
		breakdownBy: opts.breakdownBy,
	}
	const n = opts.steps.length

	const perGroup = fromQuery(levelsQuery(plan), "levels")
		.select(() => ({
			// Not `$.group`: the inner SELECT's shape is a union — the breakdown
			// branch has this column and the plain branch does not — so it is not
			// on the accessor's type even though this code path always emits it.
			group: CH.dynamicColumn("group", T.string),
			counts: stepCounts(n),
			entered: CH.countIf(CH.dynamicColumn<number>("level").gte(1)),
		}))
		.groupBy("group")
		.orderBy(["entered", "desc"], ["group", "asc"])
		.limit(limit)

	return Result.succeed(
		fromQuery(perGroup, "groups")
			.select(($) => ({
				group: $.group,
				step: stepIndex(n),
				count: CH.arrayElement($.counts, CH.dynamicColumn<number>("step")),
			}))
			.orderBy(["group", "asc"], ["step", "asc"])
			.format("JSON"),
	)
}

/**
 * Event names in range for the step picker: `{ eventName, kind, count,
 * sessions, persons }`, most frequent first.
 *
 * `persons` is the unstitched `if(UserId != '', UserId, VisitorId)` — a cheap
 * approximation that needs no `identity_links` join; the funnel itself does the
 * stitching. Sidebar filters narrow by `SessionId`, so under an active filter
 * server-side events (which carry no session) are not listed.
 */
export function productEventNamesQuery(
	opts: ProductEventNamesOpts = {},
): CHQuery<ColumnDefs, ProductEventNamesOutput> {
	const filters: ProductEventsFilters = { ...opts.filters, useProductEvents: true }
	const limit = opts.limit ?? 100
	return from(Datasources.productEvents)
		.select(($) => ({
			eventName: $.EventName,
			kind: $.Kind,
			count: CH.count(),
			sessions: CH.uniqIf($.SessionId, $.SessionId.neq("")),
			persons: CH.uniq(CH.if_($.UserId.neq(""), $.UserId, $.VisitorId)),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(filters.host, (v: string) => $.Host.eq(v)),
			needsSessionSemiJoin(filters) || filters.pagePath !== undefined
				? inSubquery(
						$.SessionId,
						from(Datasources.sessionReplays)
							.select(($s) => ({ sessionId: $s.SessionId }))
							.where(($s) => replaysWhere($s, { ...filters, host: undefined }))
							.groupBy("sessionId"),
					)
				: undefined,
		])
		.groupBy("eventName", "kind")
		.orderBy(["count", "desc"], ["eventName", "asc"])
		.limit(limit)
		.format("JSON")
}

// Trace ↔ product event linking. An annotated span lands in `product_events` as
// a `Source = 'trace'` row carrying its `TraceId`/`SpanId` (migration 0028 /
// `product_events_traces_mv`); these two queries walk that link in each
// direction. Both filter `TraceId` directly so `idx_trace_id` prunes.
//
// No declared `rowSchema`: every column is a plain String or the Map the builder
// already derives, so a declared copy would only drift.

export interface ProductEventForTraceOutput {
	readonly timestamp: DateTime.Utc
	readonly eventName: string
	readonly spanId: string
	readonly serviceName: string
	readonly userId: string
	readonly groupId: string
	readonly visitorId: string
	readonly sessionId: string
	readonly attributes: Record<string, string>
}

export interface ProductEventsForTraceOpts {
	/** Default 50 — a single trace producing more than this is pathological. */
	readonly limit?: number
}

/**
 * The product events one trace produced, oldest first. The caller's time window
 * is what keeps this off every retained partition; `Source` is not filtered
 * because only the trace projection writes a `TraceId`.
 */
export function productEventsForTraceQuery(
	opts: ProductEventsForTraceOpts = {},
): CHQuery<ColumnDefs, ProductEventForTraceOutput> {
	return from(Datasources.productEvents)
		.select(($) => ({
			timestamp: $.Timestamp,
			eventName: $.EventName,
			spanId: $.SpanId,
			serviceName: $.ServiceName,
			userId: $.UserId,
			groupId: $.GroupId,
			visitorId: $.VisitorId,
			sessionId: $.SessionId,
			attributes: $.Attributes,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.TraceId.eq(param.string("traceId")),
		])
		.orderBy(["timestamp", "asc"], ["spanId", "asc"])
		.limit(opts.limit ?? 50)
		.format("JSON")
}

export interface ProductEventTraceSampleOutput {
	readonly traceId: string
	readonly spanId: string
	readonly timestamp: DateTime.Utc
	readonly serviceName: string
	readonly userId: string
	readonly visitorId: string
}

export interface ProductEventTraceSamplesOpts {
	/** Default 20. */
	readonly limit?: number
}

/**
 * Recent traces behind one event name, newest first. `TraceId != ''` rather
 * than `Source = 'trace'`: same set, and a row with no trace id is not a sample.
 */
export function productEventTraceSamplesQuery(
	opts: ProductEventTraceSamplesOpts = {},
): CHQuery<ColumnDefs, ProductEventTraceSampleOutput> {
	return from(Datasources.productEvents)
		.select(($) => ({
			traceId: $.TraceId,
			spanId: $.SpanId,
			timestamp: $.Timestamp,
			serviceName: $.ServiceName,
			userId: $.UserId,
			visitorId: $.VisitorId,
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			$.EventName.eq(param.string("eventName")),
			$.TraceId.neq(""),
		])
		.orderBy(["timestamp", "desc"])
		.limit(opts.limit ?? 20)
		.format("JSON")
}

// Funnel drop-off details: time between steps, and where the leavers went.
//
// Both read each person's chain: the attempt the funnel counted, as the order key of the row that
// satisfied each step. An attempt starts at a step-1 row and takes, for every later step, the
// first row after the previous one that matches and is still inside the window. A person's chain
// is the earliest attempt that gets as deep as any of theirs, so a first try that ran out of time
// gives way to the later one that converted, and the level is the number the funnel counts.

/** Every event of a funnel's population in range, as `(key, ord, name)`: the rows a leaver went on to. */
function personEventsBranch(plan: FunnelPlan) {
	const { opts, filters } = plan
	const keyBy = opts.keyBy
	let base: OpenJoinQuery<typeof Datasources.productEvents.columns> = from(Datasources.productEvents, "e")
	if (keyBy === "person") {
		base = base.leftJoinQuery(identityLinksByVisitor(), LINK_ALIAS, (e, link) =>
			e.VisitorId.eq(link.VisitorId),
		)
	}
	return base
		.select(($) => ({
			key: personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined),
			ord: orderKey($.Timestamp, $.Seq),
			name: eventDisplayName($),
		}))
		.where(($) => {
			const key = personKey(keyBy, $, keyBy === "person" ? $[LINK_ALIAS] : undefined)
			return [
				$.OrgId.eq(orgIdParam),
				$.Timestamp.gte(param.dateTime("startTime")),
				$.Timestamp.lte(param.dateTime("endTime")),
				key.neq(""),
				hasPopulationFilter(filters)
					? inSubquery(key, matchingPersonsSubquery(keyBy, filters))
					: undefined,
			]
		})
}

/** What a row is called in a path or a leavers list: the page or screen for a view, else the event name. */
export function eventDisplayName(
	$: EventsAccessor | OpenJoinAccessor<typeof Datasources.productEvents.columns>,
): CH.Expr<string> {
	return CH.if_(isPageView($).and($.PagePath.neq("")), $.PagePath, $.EventName)
}

const stepOrderColumn = (index: number) => `o${index + 1}`

/**
 * `SELECT key, level, o1, …, oN`: per person, the funnel level and the order key of each step's
 * row in their chain (0 for a step the chain did not reach).
 *
 * The chain's start is the first step-1 row still inside the window when the deepest step was
 * first reached ({@link walkQuery}'s `reachedAt`): an earlier start had expired by then, and no
 * later one is needed. From there each step is the first matching row after the previous one,
 * which costs one scan of the person's rows per step.
 */
function chainQuery(plan: FunnelPlan) {
	const { opts } = plan
	const window = windowUnits(opts)
	return fromQuery(walkQuery(plan), "walked").select(($) => ({
		key: $.key,
		level: $.level,
		...Rec.fromEntries(
			Arr.map(opts.steps, (_, index) => {
				const step = index + 1
				const row =
					step === 1
						? `x.2 = 1 AND x.1 + ${window} >= reachedAt`
						: `x.${step + 1} = 1 AND x.1 > ${stepOrderColumn(index - 1)}`
				return [
					stepOrderColumn(index),
					CH.rawExpr<number>(
						`if(level >= ${step}, tupleElement(arrayFirst(x -> ${row}, evs), 1), toUInt64(0))`,
						T.uint64,
					),
				]
			}),
		),
	}))
}

function validateDetails(opts: ProductEventsFunnelOpts): ProductEventsFunnelError | undefined {
	const invalid = validate(opts)
	if (invalid !== undefined) return invalid
	if (opts.steps.length < 2) {
		return new ProductEventsFunnelError({
			reason: "TooFewSteps",
			message: `drop-off details need at least two steps, got ${opts.steps.length}`,
		})
	}
	return undefined
}

export const productEventsFunnelTimingRowSchema = Schema.Struct({
	step: CHNumber,
	/** Median milliseconds from the previous step's event to this one's, over persons who reached it. */
	p50Ms: CHNumber,
	p90Ms: CHNumber,
	/** The same from step 1's event; on the last step, the time the whole funnel took. */
	sinceStartP50Ms: CHNumber,
	sinceStartP90Ms: CHNumber,
})
export type ProductEventsFunnelTimingOutput = typeof productEventsFunnelTimingRowSchema.Type

/**
 * Time between steps: `{ step, p50Ms, p90Ms, sinceStartP50Ms, sinceStartP90Ms }` for steps
 * 2..N, in step order, over the persons the funnel counts at that step. An empty range (or a
 * step nobody reached) answers `0`, never a missing row.
 */
export function productEventsFunnelTimingQuery(
	opts: ProductEventsFunnelOpts,
): Result.Result<CHQuery<ColumnDefs, ProductEventsFunnelTimingOutput>, ProductEventsFunnelError> {
	const invalid = validateDetails(opts)
	if (invalid !== undefined) return Result.fail(invalid)
	const filters = opts.filters ?? {}
	const first = opts.steps[0]
	const plan: FunnelPlan = { opts, filters, sessionStep: first?.kind === "session" ? first : undefined }
	const n = opts.steps.length

	const millis = (index: number): string => `intDiv(${stepOrderColumn(index)}, ${ORDER_UNITS_PER_MS})`
	// One quantile per step 2..N of the span since the previous step, or since step 1.
	const quantileArray = (q: number, since: "previous" | "start"): string =>
		`[0, ${Arr.join(
			Array.from({ length: n - 1 }, (_, i) => {
				const step = i + 2
				const from = since === "start" ? millis(0) : millis(step - 2)
				return `ifNotFinite(quantileIf(${q})(toFloat64(${millis(step - 1)} - ${from}), level >= ${step}), 0)`
			}),
			", ",
		)}]`
	const quantiles = (q: number, since: "previous" | "start") =>
		CH.rawExpr<ReadonlyArray<number>>(quantileArray(q, since), T.array(T.float64))

	const totals = fromQuery(chainQuery(plan), "chain").select(() => ({
		p50s: quantiles(0.5, "previous"),
		p90s: quantiles(0.9, "previous"),
		start50s: quantiles(0.5, "start"),
		start90s: quantiles(0.9, "start"),
	}))

	return Result.succeed(
		fromQuery(totals, "totals")
			.select(($) => ({
				step: CH.arrayJoin(CH.arrayOf(...Array.from({ length: n - 1 }, (_, i) => CH.lit(i + 2)))),
				p50Ms: CH.arrayElement($.p50s, CH.dynamicColumn<number>("step")),
				p90Ms: CH.arrayElement($.p90s, CH.dynamicColumn<number>("step")),
				sinceStartP50Ms: CH.arrayElement($.start50s, CH.dynamicColumn<number>("step")),
				sinceStartP90Ms: CH.arrayElement($.start90s, CH.dynamicColumn<number>("step")),
			}))
			.orderBy(["step", "asc"])
			.format("JSON"),
	)
}

export const productEventsFunnelLeaversRowSchema = Schema.Struct({
	/** The step these persons did NOT reach (2..N). */
	step: CHNumber,
	/** What they did next; `''` when nothing followed in range. */
	next: Schema.String,
	count: CHNumber,
})
export type ProductEventsFunnelLeaversOutput = typeof productEventsFunnelLeaversRowSchema.Type

/** Rows kept per step in the leavers list: the chart draws four and folds the rest. */
export const FUNNEL_LEAVERS_PER_STEP = 6

/**
 * Where the drop-offs went: for each step 2..N, the first event after the last
 * step a leaver did reach, counted by name, most common first. `next = ''`
 * means no later event in range: the person simply stopped.
 *
 * Reads every event of the population (not just step matches) once, joined to
 * the per-person chain on the key; bounded to the top rows per step.
 */
export function productEventsFunnelLeaversQuery(
	opts: ProductEventsFunnelOpts,
): Result.Result<CHQuery<ColumnDefs, ProductEventsFunnelLeaversOutput>, ProductEventsFunnelError> {
	const invalid = validateDetails(opts)
	if (invalid !== undefined) return Result.fail(invalid)
	const filters = opts.filters ?? {}
	const first = opts.steps[0]
	const plan: FunnelPlan = { opts, filters, sessionStep: first?.kind === "session" ? first : undefined }
	const n = opts.steps.length
	const orderColumns = Arr.join(
		Arr.map(opts.steps, (_, index) => stepOrderColumn(index)),
		", ",
	)

	const dropped = fromQuery(chainQuery(plan), "chain")
		.select(($) => ({
			key: $.key,
			step: ($.level as CH.Expr<number>).add(1),
			lastOrd: CH.rawExpr<number>(`arrayElement([${orderColumns}], level)`, T.uint64),
		}))
		.where(($) => [($.level as CH.Expr<number>).gte(1), ($.level as CH.Expr<number>).lt(n)])

	const nexts = fromQuery(personEventsBranch(plan), "e")
		.innerJoinQuery(dropped, "d", (e, d) => e.key.eq(d.key))
		.select(($) => ({
			key: $.key,
			step: $.d.step as CH.Expr<number>,
			next: argMinIf(
				$.name as CH.Expr<string>,
				$.ord,
				($.ord as CH.Expr<number>).gt($.d.lastOrd as CH.Expr<number>),
			),
		}))
		.groupBy("key", "step")

	const counted = fromQuery(nexts, "nexts")
		.select(($) => ({ step: $.step, next: $.next, count: CH.count() }))
		.groupBy("step", "next")

	// Top rows per step without `LIMIT BY`: fold each step's rows into an array, sort it by count
	// (ties by name, so the cut is the same on every run), take the head, and explode it again.
	const ranked = fromQuery(counted, "counted")
		.select(($) => ({
			step: $.step,
			head: CH.untypedExpr(
				`arraySlice(arraySort(x -> (-toInt64(x.2), x.1), groupArray(tuple(next, count))), 1, ${FUNNEL_LEAVERS_PER_STEP})`,
			),
		}))
		.groupBy("step")

	const hops = fromQuery(ranked, "ranked").select(($) => ({
		step: $.step,
		hop: CH.untypedExpr("arrayJoin(head)"),
	}))

	return Result.succeed(
		fromQuery(hops, "hops")
			.select(($) => ({
				step: $.step,
				next: CH.rawExpr<string>("tupleElement(hop, 1)", T.string),
				count: CH.rawExpr<number>("tupleElement(hop, 2)", T.uint64),
			}))
			.orderBy(["step", "asc"], ["count", "desc"], ["next", "asc"])
			.format("JSON"),
	)
}
