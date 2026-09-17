// The Overview's verdict and findings: discrete claims about what went wrong
// or looked off, each anchored to the span that is its evidence.
//
// Every detector here is a deterministic read of captured spans — grouped
// failures, finish reasons, call counts, holes in the timeline — phrased in the
// instrumentation's own vocabulary. Nothing is scored, sampled or modeled: a
// finding the reader clicks through to must be exactly what the spans say.

import type { AiSessionSpan } from "@maple/domain/http"

import { formatNumber, formatSessionDuration } from "@maple/domain/format"
import { canonicalJSON } from "@maple/query-engine"
import { clipDetail, failureDetailText } from "./failure-text"
import {
	failureEvents,
	findIdleGaps,
	isProviderAttempt,
	shadowedAncestorIds,
	spanTokenBuckets,
	type SessionFailureKind,
	type SessionSummary,
} from "./session-summary"
import {
	classifyAiSpan,
	isLlmCall,
	spanEndMs,
	spanFailed,
	spanStartMs,
	type SessionTurn,
} from "./session-turns"

/** Same tool this often within one turn reads as the agent going in circles. */
const REPEATED_TOOL_MIN_CALLS = 8

/**
 * The same call — tool and arguments — this many times in a row, with nothing
 * between, is a loop whatever the tool's total. One unchanged retry after a
 * failure is not: a transient 429 or timeout is retried exactly that way.
 */
const IDENTICAL_RUN_MIN_CALLS = 3

/**
 * A hole this long INSIDE a turn is the framework stalled mid-flight. Gaps
 * between turns are the user thinking and are never findings — the session-wide
 * `IDLE_GAP_MIN_MS` covers those on the time bar.
 */
const MID_TURN_STALL_MIN_MS = 30_000

/** Finish reasons that mean the reply was cut off at the output token limit. */
const TRUNCATION_FINISH_REASONS = new Set(["length", "max_tokens", "max_output_tokens"])

/**
 * Failure kinds that need a fix whether or not the run survived them: the
 * prompt will outgrow the window again, the schema will reject the next reply,
 * the tool will still not be connected, the run will end without its
 * completion tool again. Every other kind is red only when the final turn
 * died on it — a rate limit, a refusal, a tool error the agent recovered from
 * is worth a look, not a fix.
 */
const FAILURE_KINDS: ReadonlySet<SessionFailureKind> = new Set([
	"contextExceeded",
	"invalidOutput",
	"toolUnavailable",
	"incomplete",
])

/** Red or amber: whether the thing found ended the run or names a class that
 *  needs a fix regardless, or was survived. The checklist's failed/warning
 *  split reads the same field, so the two never disagree. */
export type FindingSeverity = "failure" | "anomaly"

/** Which detector produced the row: a failure kind, or one of the four
 *  session-shape detectors below. What the checklist groups rows on. */
export type SessionFindingKind = SessionFailureKind | "providerRetry" | "truncation" | "repetition" | "stall"

export interface SessionFinding {
	readonly id: string
	readonly kind: SessionFindingKind
	readonly severity: FindingSeverity
	/** The leading token, in the instrumentation's vocabulary where one exists —
	 *  `context_length_exceeded`, `tool_error · run_tests`, `stop length`. */
	readonly label: string
	/** The tool the row is about, for the kinds that name one. */
	readonly tool: string | undefined
	/** How many spans said it. The row prints ×N above one. */
	readonly count: number
	/** `Turn 14 (final)`, `Turns 9, 11` — where it happened. */
	readonly turnText: string
	/** The final turn died on this row's span: the verdict's own evidence. */
	readonly terminal: boolean
	/** One line of evidence under the label, when the spans carry any. */
	readonly detail: string | undefined
	/** The span the row opens in the Traces view. */
	readonly spanId: string
	/** First occurrence, for ordering. */
	readonly atMs: number
}

export type SessionVerdictStatus = "failed" | "attention" | "clean"

export interface SessionVerdict {
	readonly status: SessionVerdictStatus
	/** The failing span, for the verdict's own link. */
	readonly spanId: string | undefined
}

export interface SessionFindingsReport {
	readonly verdict: SessionVerdict
	/** Failures first, the terminal one leading, then anomalies, each in time order. */
	readonly findings: readonly SessionFinding[]
}

/** A trace-anchored turn is the fallback partition — one turn per trace — so it
 *  is a segment of the session rather than an exchange with the user. */
export function turnOrdinal(turn: SessionTurn): string {
	return `${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`
}

export function buildSessionFindings(
	turns: readonly SessionTurn[],
	summary: SessionSummary,
): SessionFindingsReport {
	const spans = turns.flatMap((turn) => turn.spans).sort((a, b) => spanStartMs(a) - spanStartMs(b))
	const turnIndexBySpan = new Map<string, number>()
	turns.forEach((turn, index) => {
		for (const span of turn.spans) turnIndexBySpan.set(span.spanId, index)
	})
	const lastTurnIndex = turns.length - 1
	const events = failureEvents(spans)

	// The LAST failure event in the final turn is the one the turn died on — an
	// earlier rate-limited retry in the same turn is a finding, not the cause.
	const cause = summary.failed
		? events.findLast((event) => turnIndexBySpan.get(event.span.spanId) === lastTurnIndex)
		: undefined

	const findings = [
		...failureFindings(events, turns, turnIndexBySpan, cause?.span.spanId, spans),
		...retryFindings(spans, turns, turnIndexBySpan),
		...truncationFindings(spans, turns, turnIndexBySpan),
		...repetitionFindings(turns),
		...stallFindings(turns),
	].sort(
		(a, b) =>
			severityRank(a.severity) - severityRank(b.severity) ||
			// The terminal failure leads: it is the verdict's own evidence.
			Number(b.terminal) - Number(a.terminal) ||
			a.atMs - b.atMs,
	)

	const verdict: SessionVerdict = summary.failed
		? { status: "failed", spanId: cause?.span.spanId }
		: { status: findings.length > 0 ? "attention" : "clean", spanId: undefined }

	return { verdict, findings }
}

function severityRank(severity: FindingSeverity): number {
	return severity === "failure" ? 0 : 1
}

/* -------------------------------------------------------------------------- */
/* Detectors                                                                  */
/* -------------------------------------------------------------------------- */

function failureFindings(
	events: ReturnType<typeof failureEvents>,
	turns: readonly SessionTurn[],
	turnIndexBySpan: ReadonlyMap<string, number>,
	/** The span the final turn died on — its group is the terminal finding. */
	causeSpanId: string | undefined,
	spans: readonly AiSessionSpan[],
): SessionFinding[] {
	const byLabel = new Map<
		string,
		{
			kind: SessionFailureKind
			tool: string | undefined
			members: { span: AiSessionSpan; turnIndex: number }[]
		}
	>()
	for (const event of events) {
		const turnIndex = turnIndexBySpan.get(event.span.spanId) ?? 0
		const group = byLabel.get(event.label) ?? { kind: event.kind, tool: event.tool, members: [] }
		group.members.push({ span: event.span, turnIndex })
		byLabel.set(event.label, group)
	}

	return [...byLabel].map(([label, group]) => {
		const turnIndices = distinctSorted(group.members.map((member) => member.turnIndex))
		// The terminal group links the span the turn died on; a recovered group
		// links its first event, where the trouble began.
		const cause =
			causeSpanId === undefined
				? undefined
				: group.members.find((member) => member.span.spanId === causeSpanId)
		const terminal = cause !== undefined
		const linked = cause ?? group.members[0]
		return {
			id: `failure:${label}`,
			kind: group.kind,
			severity: terminal || FAILURE_KINDS.has(group.kind) ? ("failure" as const) : ("anomaly" as const),
			label,
			tool: group.tool,
			count: group.members.length,
			turnText: turnListText(turnIndices, turns, terminal),
			terminal,
			detail:
				(group.kind === "contextExceeded" ? promptGrowth(spans) : undefined) ??
				failureDetail(
					group.members.map((member) => member.span),
					label,
				),
			spanId: linked.span.spanId,
			atMs: spanStartMs(group.members[0].span),
		}
	})
}

/**
 * The group's evidence line: the first member that says anything, read the
 * way `failure-text.ts` reads every failed span — the status message unless
 * it is the framework's generic one, else the tool call's recorded result,
 * with the framework's prefixes stripped and a schema path made readable.
 */
function failureDetail(spans: readonly AiSessionSpan[], label: string): string | undefined {
	for (const span of spans) {
		const detail = failureDetailText(span)
		if (detail !== undefined && detail !== label) return detail
	}
	return undefined
}

/**
 * A gateway's failed provider attempts, rolled up into one row: how many, on
 * which statuses, at which providers, and whether the generations above them
 * recovered. Attempts are never failure events ({@link isProviderAttempt}); a
 * generation that ran out of providers is its own `provider_error` finding.
 */
function retryFindings(
	spans: readonly AiSessionSpan[],
	turns: readonly SessionTurn[],
	turnIndexBySpan: ReadonlyMap<string, number>,
): SessionFinding[] {
	const byId = new Map(spans.map((span) => [span.spanId, span]))
	const attempts = spans.filter((span) => isProviderAttempt(span) && spanFailed(span))
	const first = attempts[0]
	if (first === undefined) return []

	const byStatus = new Map<string, number>()
	const providers = new Set<string>()
	const generations = new Set<string>()
	const failedGenerations = new Set<string>()
	for (const attempt of attempts) {
		const status = attempt.genAi.attemptStatusCode
		const key = status === undefined ? "error" : String(status)
		byStatus.set(key, (byStatus.get(key) ?? 0) + 1)
		if (attempt.genAi.attemptProvider !== undefined) providers.add(attempt.genAi.attemptProvider)
		const parent = byId.get(attempt.parentSpanId)
		if (parent === undefined) continue
		generations.add(parent.spanId)
		if (spanFailed(parent)) failedGenerations.add(parent.spanId)
	}

	const statuses = [...byStatus]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([status, count]) => `${status} ×${count}`)
		.join(" · ")
	const where = providers.size === 0 ? "" : ` — ${[...providers].sort().join(", ")}`
	const outcome =
		generations.size === 0
			? ""
			: failedGenerations.size === 0
				? " · all recovered"
				: ` · ${failedGenerations.size} of ${generations.size} calls did not recover`

	return [
		{
			id: "provider-retry",
			kind: "providerRetry",
			severity: "anomaly",
			label: "provider_retry",
			tool: undefined,
			count: attempts.length,
			turnText: turnListText(
				distinctSorted(attempts.map((span) => turnIndexBySpan.get(span.spanId) ?? 0)),
				turns,
				false,
			),
			terminal: false,
			detail: clipDetail(`${statuses}${where}${outcome}`),
			spanId: first.spanId,
			atMs: spanStartMs(first),
		},
	]
}

/**
 * How the prompt grew over the session's model calls — the story behind a
 * context-window death. Prompt size is the input-side buckets (uncached input
 * plus both cache buckets: what the model actually had in front of it).
 */
function promptGrowth(spans: readonly AiSessionSpan[]): string | undefined {
	const promptSizes = spans
		.filter(isLlmCall)
		.map(spanTokenBuckets)
		.filter((buckets) => buckets !== undefined)
		.map((buckets) => buckets.input + buckets.cacheRead + buckets.cacheWrite)
		.filter((size) => size > 0)
	const first = promptSizes[0]
	const last = promptSizes[promptSizes.length - 1]
	if (first === undefined || last === undefined || promptSizes.length < 2 || last <= first) {
		return undefined
	}
	return `prompt grew ${formatNumber(first)} → ${formatNumber(last)} tokens across the session`
}

function truncationFindings(
	spans: readonly AiSessionSpan[],
	turns: readonly SessionTurn[],
	turnIndexBySpan: ReadonlyMap<string, number>,
): SessionFinding[] {
	const shadowed = shadowedAncestorIds(spans, truncationSignal)
	const members = spans.flatMap((span) => {
		const reason = truncationSignal(span)
		return reason === undefined || shadowed.has(span.spanId) ? [] : [{ span, reason }]
	})
	const first = members[0]
	if (first === undefined) return []
	return [
		{
			id: "truncation",
			kind: "truncation",
			severity: "anomaly",
			// `stop <reason>` is how the transcript's meta line already spells a
			// finish reason, so the finding reads in the same vocabulary.
			label: `stop ${first.reason}`,
			tool: undefined,
			count: members.length,
			turnText: turnListText(
				distinctSorted(members.map(({ span }) => turnIndexBySpan.get(span.spanId) ?? 0)),
				turns,
				false,
			),
			terminal: false,
			detail: "the reply hit the output token limit and was cut off",
			spanId: first.span.spanId,
			atMs: spanStartMs(first.span),
		},
	]
}

function truncationSignal(span: AiSessionSpan): string | undefined {
	const reasons = (span.genAi.responseFinishReasons ?? [])
		.map((reason) => reason.toLowerCase())
		.filter((reason) => TRUNCATION_FINISH_REASONS.has(reason))
	return reasons.length === 0 ? undefined : reasons.join(",")
}

function repetitionFindings(turns: readonly SessionTurn[]): SessionFinding[] {
	const findings: SessionFinding[] = []
	turns.forEach((turn, index) => {
		const calls = turn.spans.filter((span) => classifyAiSpan(span) === "tool")
		const byTool = new Map<string, AiSessionSpan[]>()
		for (const span of calls) {
			const name = toolNameOf(span)
			const list = byTool.get(name) ?? []
			list.push(span)
			byTool.set(name, list)
		}
		const runs = longestIdenticalRuns(calls)
		for (const [name, toolCalls] of byTool) {
			const run = runs.get(name) ?? []
			const looped = run.length >= IDENTICAL_RUN_MIN_CALLS
			if (toolCalls.length < REPEATED_TOOL_MIN_CALLS && !looped) continue
			// The row links where the loop began, else the tool's first call.
			const first = looped ? run[0] : toolCalls[0]
			findings.push({
				id: `repetition:${turn.id}:${name}`,
				kind: "repetition",
				severity: "anomaly",
				label: name,
				tool: name,
				count: 1,
				turnText: turnListText([index], turns, false),
				terminal: false,
				detail: looped
					? spanFailed(run[0])
						? `retried ${run.length - 1}× unchanged after it failed`
						: `called ${toolCalls.length}× within one turn, ${run.length} in a row with identical arguments`
					: `called ${toolCalls.length}× within one turn`,
				spanId: first.spanId,
				atMs: spanStartMs(first),
			})
		}
	})
	return findings
}

function toolNameOf(span: AiSessionSpan): string {
	return span.genAi.toolName ?? span.spanName
}

/**
 * Per tool, the longest run of back-to-back calls that sent the same
 * arguments — back-to-back across every tool call of the turn, in start
 * order, with nothing at all between. A test suite re-run after a write sends
 * the same arguments over new code, which is progress; the same call three
 * times with nothing between is not. A tool whose calls never recorded
 * arguments has no run. Among runs of equal length the one that opened with a
 * failure wins, since that is the one the row should say retried. Arguments
 * compare as canonical JSON so key order cannot split a run.
 */
function longestIdenticalRuns(
	calls: readonly AiSessionSpan[],
): ReadonlyMap<string, readonly AiSessionSpan[]> {
	const longest = new Map<string, readonly AiSessionSpan[]>()
	let run: AiSessionSpan[] = []
	let key: string | undefined
	for (const span of calls) {
		// `?? undefined`: a JSON `null` is a call that recorded nothing.
		const args = span.genAi.toolCallArguments ?? undefined
		const name = toolNameOf(span)
		const next = args === undefined ? undefined : `${name}\u0000${canonicalJSON(args)}`
		if (next !== undefined && next === key) {
			run.push(span)
		} else {
			run = next === undefined ? [] : [span]
			key = next
		}
		if (run.length === 0) continue
		const best = longest.get(name)
		if (
			best === undefined ||
			run.length > best.length ||
			(run.length === best.length && spanFailed(run[0]) && !spanFailed(best[0]))
		) {
			// A copy: the run keeps growing after it is recorded.
			longest.set(name, [...run])
		}
	}
	return longest
}

function stallFindings(turns: readonly SessionTurn[]): SessionFinding[] {
	const findings: SessionFinding[] = []
	turns.forEach((turn, index) => {
		for (const gap of findIdleGaps(turn.spans)) {
			if (gap.durationMs < MID_TURN_STALL_MIN_MS) continue
			// The row links the span the session went quiet after — the closest
			// thing the capture has to what it was stuck on.
			const before = [...turn.spans]
				.filter((span) => spanEndMs(span) <= gap.startMs)
				.sort((a, b) => spanEndMs(b) - spanEndMs(a))[0]
			findings.push({
				id: gap.id,
				kind: "stall",
				severity: "anomaly",
				// The waterfall names its gap rows `idle 4m 20s`; same vocabulary.
				label: `idle ${formatSessionDuration(gap.durationMs)}`,
				tool: undefined,
				count: 1,
				turnText: turnListText([index], turns, false),
				terminal: false,
				detail: "no span activity mid-turn",
				spanId: before?.spanId ?? turn.anchor.spanId,
				atMs: gap.startMs,
			})
		}
	})
	return findings
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

/** `Turn 4 (final)`, `Turns 9, 11`, `Segments 1, 2`, `6 of 14 turns`. */
function turnListText(indices: readonly number[], turns: readonly SessionTurn[], terminal: boolean): string {
	const word = turns[0]?.anchorKind === "trace" ? "Segment" : "Turn"
	if (indices.length === 1) {
		const one = `${word} ${turns[indices[0]]?.index ?? indices[0] + 1}`
		return terminal ? `${one} (final)` : one
	}
	if (indices.length > 4) return `${indices.length} of ${turns.length} ${word.toLowerCase()}s`
	const numbers = indices.map((index) => turns[index]?.index ?? index + 1).join(", ")
	return `${word}s ${numbers}${terminal ? " (final)" : ""}`
}

function distinctSorted(values: readonly number[]): readonly number[] {
	return [...new Set(values)].sort((a, b) => a - b)
}
