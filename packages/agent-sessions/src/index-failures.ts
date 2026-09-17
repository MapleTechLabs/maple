// The list's breakdown of a session's failures, off `ai_trace_index` alone.
//
// The detail page names what went wrong from the session's spans
// (`failureEvents` → `buildSessionFindings`). The list cannot read spans —
// a page is one index query, and the fan-out costs seconds per partition —
// but since migration 0032 the index carries every field the classifier
// reads off a failed span, so the page query ships the failed rows and this
// module classifies them with the SAME `classifyFailureSignal` and the SAME
// severity rule. A session the detail page calls failed on
// `context_length_exceeded` is red in the list for the same reason.
//
// What the index cannot say, the list does not claim: refusals and truncated
// replies (finish reasons), loops and stalls (the turn timeline) are the
// detail page's, and all of them are amber there unless the run died on one.

import { rawFailureTextOf } from "./failure-text"
import { failureSeverity, type FindingSeverity } from "./session-findings"
import {
	classifyFailureSignal,
	failureSpecificity,
	type SessionFailureClass,
	type SessionFailureKind,
} from "./session-summary"

/** One failed agent span as the page query ships it: the deepest span of a
 *  roll-up, with the index columns the classifier reads. */
export interface IndexFailedSpan {
	readonly spanId: string
	readonly traceId: string
	readonly isToolCall: boolean
	readonly isLlmCall: boolean
	/** `''` where the span stamped none, or the row predates migration 0032. */
	readonly errorType: string
	readonly toolName: string
	readonly vendorId: string
	readonly statusMessage: string
	readonly failedToolCallResult: string
	readonly responseId: string
	readonly atMs: number
}

/** One line of the list's breakdown: a failure label, how often, how bad. */
export interface SessionFailureSummary {
	readonly kind: SessionFailureKind
	/** `context_length_exceeded`, `tool_error · run_tests` — the finding's label. */
	readonly label: string
	readonly tool: string | undefined
	readonly count: number
	readonly severity: FindingSeverity
	/** The session's last turn died on it. */
	readonly terminal: boolean
}

/**
 * Failures grouped by label, red ones first and the terminal one leading —
 * the order `buildSessionFindings` gives its failure rows.
 *
 * `terminal` is the detail page's verdict approximated one trace deep: the
 * session's last trace had a turn-level failure (`lastTraceTurnFailed`, from
 * every failed span of that trace, echoes included), and the failure it died
 * on is the last one in that trace. A turn that crosses traces can differ.
 */
export function summarizeIndexFailures(
	spans: readonly IndexFailedSpan[],
	lastTrace: { readonly traceId: string; readonly turnFailed: boolean },
): readonly SessionFailureSummary[] {
	const events = dedupeByResponseId(
		[...spans]
			.sort((a, b) => a.atMs - b.atMs)
			.map((span) => ({ span, ...classifyFailureSignal(signalOf(span)) })),
	)
	const cause = lastTrace.turnFailed
		? events.findLast((event) => event.span.traceId === lastTrace.traceId)
		: undefined

	const groups = new Map<
		string,
		{ kind: SessionFailureKind; tool: string | undefined; count: number; terminal: boolean; atMs: number }
	>()
	for (const event of events) {
		const group = groups.get(event.label) ?? {
			kind: event.kind,
			tool: event.tool,
			count: 0,
			terminal: false,
			atMs: event.span.atMs,
		}
		group.count += 1
		group.terminal ||= event === cause
		groups.set(event.label, group)
	}

	return [...groups]
		.map(([label, group]) => ({
			kind: group.kind,
			label,
			tool: group.tool,
			count: group.count,
			severity: failureSeverity(group.kind, group.terminal),
			terminal: group.terminal,
			atMs: group.atMs,
		}))
		.sort(
			(a, b) =>
				Number(a.severity === "anomaly") - Number(b.severity === "anomaly") ||
				Number(b.terminal) - Number(a.terminal) ||
				a.atMs - b.atMs,
		)
		.map(({ atMs: _atMs, ...summary }) => summary)
}

function signalOf(span: IndexFailedSpan) {
	return {
		errorType: span.errorType === "" ? undefined : span.errorType,
		responseStatus: undefined,
		statusMessage: span.statusMessage,
		// The view keeps the result only on failed tool calls, as text.
		toolCallResult: span.failedToolCallResult === "" ? undefined : span.failedToolCallResult,
		tool: span.toolName !== "" ? span.toolName : span.isToolCall ? "tool" : undefined,
		isLlmCall: span.isLlmCall,
		vendorId: span.vendorId === "" ? undefined : span.vendorId,
	}
}

type IndexFailureEvent = SessionFailureClass & { readonly span: IndexFailedSpan }

/** Same rule as `session-summary.ts`'s `dedupeByResponseId`, over index rows:
 *  a call the app and a gateway mirror both observed is one failure, and the
 *  observation that named the cause keeps it. */
function dedupeByResponseId(events: readonly IndexFailureEvent[]): readonly IndexFailureEvent[] {
	const slots = new Map<string, { index: number; event: IndexFailureEvent }>()
	const kept: IndexFailureEvent[] = []
	for (const event of events) {
		const id = event.span.responseId
		if (id === "") {
			kept.push(event)
			continue
		}
		const slot = slots.get(id)
		if (slot === undefined) {
			slots.set(id, { index: kept.length, event })
			kept.push(event)
			continue
		}
		const specific = failureSpecificity(event) - failureSpecificity(slot.event)
		const longer = textLength(event.span) - textLength(slot.event.span)
		if (specific > 0 || (specific === 0 && longer > 0)) {
			kept[slot.index] = event
			slot.event = event
		}
	}
	return kept
}

function textLength(span: IndexFailedSpan): number {
	return (rawFailureTextOf(signalOf(span)) ?? "").length
}
