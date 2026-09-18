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
// The index also carries no `gen_ai.response.status`, so a rate limit a span
// reports there and nowhere else is a plain `error` here and `rate_limit` on
// the detail page; and no attempt marker, so a gateway's provider attempts
// (`isProviderAttempt`) count here where the detail page folds them into
// one retry.

import type { AiSessionIndexFailedSpan } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { rawFailureTextOf } from "./failure-text"
import { failureSeverity, type FindingSeverity } from "./session-findings"
import {
	classifyFailureSignal,
	failureSpecificity,
	type FailureSignal,
	type SessionFailureClass,
	type SessionFailureKind,
} from "./session-summary"

/** One failed agent span as the page query ships it — see the domain type. */
export type IndexFailedSpan = AiSessionIndexFailedSpan

/** One line of the list's breakdown: a failure label, how often, how bad. */
export interface SessionFailureSummary {
	readonly kind: SessionFailureKind
	/** `context_length_exceeded`, `tool_error · run_tests` — the finding's label. */
	readonly label: string
	/** Absent, not `undefined`: the wire schema's `optionalKey` rejects a
	 *  present key holding `undefined`. */
	readonly tool?: string
	readonly count: number
	readonly severity: FindingSeverity
	/** The session's last turn died on it. */
	readonly terminal: boolean
}

/**
 * Failures grouped by label, red ones first and the terminal one leading —
 * the order `buildSessionFindings` gives its failure rows.
 *
 * `terminalSpanId` is the span the page query resolved the session's last
 * turn died on (`terminalSpanIdExpr`), or `''`; the group holding that span
 * — under whichever observation of the call the dedupe kept — is terminal.
 * A terminal span the query did not ship (past its per-trace detail cap)
 * marks nothing: the verdict is by identity, never by position.
 */
export function summarizeIndexFailures(
	spans: readonly IndexFailedSpan[],
	terminalSpanId: string,
): readonly SessionFailureSummary[] {
	const events = dedupeByResponseId(
		[...spans]
			// Span id breaks a same-millisecond tie: the array arrives in no order.
			.sort((a, b) => a.atMs - b.atMs || a.spanId.localeCompare(b.spanId))
			.map((span) => ({ span, spanIds: [span.spanId], ...classifyFailureSignal(signalOf(span)) })),
	)

	const groups = new Map<
		string,
		{
			kind: SessionFailureKind
			tool: string | undefined
			count: number
			terminal: boolean
			atMs: number
			spanId: string
		}
	>()
	for (const event of events) {
		const group = groups.get(event.label) ?? {
			kind: event.kind,
			tool: event.tool,
			count: 0,
			terminal: false,
			atMs: event.span.atMs,
			spanId: event.span.spanId,
		}
		group.count += 1
		group.terminal ||= terminalSpanId !== "" && event.spanIds.includes(terminalSpanId)
		groups.set(event.label, group)
	}

	return [...groups]
		.map(([label, group]) => {
			const summary = {
				kind: group.kind,
				label,
				count: group.count,
				severity: failureSeverity(group.kind, group.terminal),
				terminal: group.terminal,
				atMs: group.atMs,
				spanId: group.spanId,
			}
			return group.tool === undefined ? summary : { ...summary, tool: group.tool }
		})
		.sort(
			(a, b) =>
				Number(a.severity === "anomaly") - Number(b.severity === "anomaly") ||
				Number(b.terminal) - Number(a.terminal) ||
				a.atMs - b.atMs ||
				a.spanId.localeCompare(b.spanId),
		)
		.map(({ atMs: _atMs, spanId: _spanId, ...summary }) => summary)
}

function signalOf(span: IndexFailedSpan): FailureSignal {
	return {
		errorType: span.errorType === "" ? undefined : span.errorType,
		responseStatus: undefined,
		statusMessage: span.statusMessage,
		// The view keeps a failed tool call's result as text, clipped; the
		// classifier reads it as the span carries it — JSON where it still
		// parses, else the text itself.
		toolCallResult:
			span.failedToolCallResult === "" ? undefined : toolCallResultOf(span.failedToolCallResult),
		tool: span.toolName !== "" ? span.toolName : span.isToolCall ? "tool" : undefined,
		isLlmCall: span.isLlmCall,
		vendorId: span.vendorId === "" ? undefined : span.vendorId,
	}
}

type ToolCallResult = FailureSignal["toolCallResult"]
const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
/** The clipped text parsed where it still is JSON, else as it is. */
function toolCallResultOf(text: string): ToolCallResult {
	return Option.getOrElse(decodeJsonText(text), () => text)
}

interface IndexFailureEvent extends SessionFailureClass {
	readonly span: IndexFailedSpan
	/** Every observation's span this event stands for — its own, plus those
	 *  of the duplicates dropped under it, so the terminal span is found under
	 *  whichever observation the dedupe kept. */
	readonly spanIds: string[]
}

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
		const winner = specific > 0 || (specific === 0 && longer > 0) ? event : slot.event
		const merged = { ...winner, spanIds: [...slot.event.spanIds, ...event.spanIds] }
		kept[slot.index] = merged
		slot.event = merged
	}
	return kept
}

function textLength(span: IndexFailedSpan): number {
	return (rawFailureTextOf(signalOf(span)) ?? "").length
}
