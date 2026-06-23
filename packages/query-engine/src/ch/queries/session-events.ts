// ---------------------------------------------------------------------------
// Typed Session Event Queries
//
// DSL-based queries over the session_events datasource — the distilled,
// structured event stream (navigation/click/input/console/network/error)
// captured client-side by the @maple-dev/browser SDK. Powers the in-session search
// + transcript surfaced to humans (replay panels) and agents (MCP tools).
//
// Plain MergeTree, immutable append; no ReplacingMergeTree dedup needed.
// ---------------------------------------------------------------------------

import * as CH from "@maple-dev/clickhouse-builder/expr"
import { compileFnCall } from "@maple-dev/clickhouse-builder"
import { param } from "@maple-dev/clickhouse-builder"
import { from } from "@maple-dev/clickhouse-builder"
import { SessionEvents } from "../tables"

function count(): CH.Expr<number> {
	return compileFnCall<number>("count")
}

function minExpr<T>(value: CH.Expr<T>): CH.Expr<T> {
	return compileFnCall<T>("min", value)
}

function maxExpr<T>(value: CH.Expr<T>): CH.Expr<T> {
	return compileFnCall<T>("max", value)
}

/** `argMin(value, ordering)` — the value of `value` at the row with the smallest `ordering`. */
function argMinExpr<T>(value: CH.Expr<T>, ordering: CH.Expr<unknown>): CH.Expr<T> {
	return compileFnCall<T>("argMin", value, ordering)
}

// ---------------------------------------------------------------------------
// Transcript: every event for one session, in order
//
// (OrgId, SessionId) is the sort-key prefix, so this is a contiguous range
// scan. Timestamp + Seq give a stable playback/reading order.
// ---------------------------------------------------------------------------

export interface SessionTranscriptOutput {
	readonly timestamp: string
	readonly seq: number
	readonly type: string
	readonly url: string
	readonly traceId: string
	readonly level: string
	readonly message: string
	readonly targetSelector: string
	readonly targetText: string
	readonly netMethod: string
	readonly netUrl: string
	readonly netStatus: number
	readonly netDurationMs: number
	readonly errorStack: string
}

export interface SessionTranscriptOpts {
	/** Restrict to these event types (navigation/click/input/console/network/error). */
	types?: readonly string[]
	/** Only events that occurred under this trace id. */
	traceId?: string
	/** Only "things that went wrong": error events, console errors, and failed (>=400) requests. */
	errorsOnly?: boolean
	/** Page size. Transcripts are unbounded otherwise — always cap for agents. */
	limit?: number
	offset?: number
}

export function sessionTranscriptQuery(opts: SessionTranscriptOpts = {}) {
	return from(SessionEvents)
		.select(($) => ({
			timestamp: $.Timestamp,
			seq: $.Seq,
			type: $.Type,
			url: $.Url,
			traceId: $.TraceId,
			level: $.Level,
			message: $.Message,
			targetSelector: $.TargetSelector,
			targetText: $.TargetText,
			netMethod: $.NetMethod,
			netUrl: $.NetUrl,
			netStatus: $.NetStatus,
			netDurationMs: $.NetDurationMs,
			errorStack: $.ErrorStack,
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.SessionId.eq(param.string("sessionId")),
			opts.types && opts.types.length > 0 ? CH.inList($.Type, opts.types) : undefined,
			CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
			CH.whenTrue(opts.errorsOnly, () =>
				$.Type.eq("error")
					.or($.Type.eq("console").and($.Level.eq("error")))
					.or($.Type.eq("network").and($.NetStatus.gte(400))),
			),
		])
		.orderBy(["timestamp", "asc"], ["seq", "asc"])
		.limit(opts.limit ?? 100)
		.offset(opts.offset ?? 0)
		.format("JSON")
}

// ---------------------------------------------------------------------------
// Search: sessions containing events that match the given predicates
//
// Row-level filters are ANDed, so callers pass a coherent predicate set (e.g.
// type="network" + minStatus=500, or messageSearch="…"). Returns one row per
// session with a match, plus the match count and time bounds, ordered by most
// recent. The MCP / UI layer joins these session ids back to session metadata.
// ---------------------------------------------------------------------------

export interface SearchSessionsByEventOpts {
	type?: string
	level?: string
	/** Network status >= this (e.g. 500 for server errors). */
	minStatus?: number
	/** Substring match on the event URL (page or request). */
	urlSearch?: string
	/** Substring match on console/error message text. */
	messageSearch?: string
	traceId?: string
	limit?: number
	offset?: number
}

export interface SearchSessionsByEventOutput {
	readonly sessionId: string
	readonly matchCount: number
	readonly firstTimestamp: string
	readonly lastTimestamp: string
	/** Page URL of the earliest matching event — helps an agent pick which session to read. */
	readonly firstUrl: string
}

export function searchSessionsByEventQuery(opts: SearchSessionsByEventOpts) {
	const limit = opts.limit ?? 50

	return from(SessionEvents)
		.select(($) => ({
			sessionId: $.SessionId,
			matchCount: count(),
			firstTimestamp: minExpr($.Timestamp),
			lastTimestamp: maxExpr($.Timestamp),
			firstUrl: argMinExpr($.Url, $.Timestamp),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.Timestamp.gte(param.dateTime("startTime")),
			$.Timestamp.lte(param.dateTime("endTime")),
			CH.when(opts.type, (v: string) => $.Type.eq(v)),
			CH.when(opts.level, (v: string) => $.Level.eq(v)),
			CH.when(opts.minStatus, (v: number) => $.NetStatus.gte(v)),
			CH.when(opts.urlSearch, (v: string) => $.Url.ilike(`%${v}%`)),
			CH.when(opts.messageSearch, (v: string) => $.Message.ilike(`%${v}%`)),
			CH.when(opts.traceId, (v: string) => $.TraceId.eq(v)),
		])
		.groupBy("sessionId")
		.orderBy(["lastTimestamp", "desc"])
		.limit(limit)
		.offset(opts.offset ?? 0)
		.format("JSON")
}
