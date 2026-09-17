// The Overview's checklist: every check the page runs over a session, each
// with a status, a plain-English headline and — when something was found —
// what to do about it.
//
// The findings (`session-findings.ts`) are the evidence: rows in the
// instrumentation's own vocabulary, each anchored to a span. A check is the
// reading of them a customer can act on — "2 model calls were rate-limited on
// turn 14; the session carried on" rather than `rate_limit ×2`. Every check
// has a passed state that carries the fact it measured, so a clean session
// reads as inspected rather than empty, and a check the instrumentation cannot
// support says what to capture instead of passing silently.

import type { AiSessionSpan } from "@maple/domain/http"

import { formatNumber, formatSessionDuration } from "@maple/domain/format"
import {
	buildSessionFindings,
	type SessionFinding,
	type SessionFindingKind,
	type SessionFindingsReport,
	type SessionVerdict,
} from "./session-findings"
import {
	spanTokenBuckets,
	type SessionFailureKind,
	type SessionSummary,
	type SessionTokenReporting,
} from "./session-summary"
import {
	classifyAiSpan,
	isLlmCall,
	spanStartMs,
	type SessionTurn,
	type TurnAnchorKind,
} from "./session-turns"

/** Below this share of the prompt served from cache, across the calls after
 *  the first, the prefix is not being reused. */
const CACHE_HIT_MIN_RATE = 0.5
/** Fewer calls than this say nothing about the cache either way. */
const CACHE_MIN_CALLS = 3
/** A headline names this many findings before it counts the rest. */
const HEADLINE_MAX_CLAUSES = 3

export type SessionCheckStatus = "failed" | "warning" | "passed" | "skipped"

/** What a fix would touch — the tag a reader filters on for what they own. */
export type SessionFixArea = "prompt" | "tool" | "integration" | "model" | "provider" | "instrumentation"

export interface SessionCheck {
	readonly id: string
	/** Plain English: `Context window`, `Tool arguments`. */
	readonly name: string
	/**
	 * `failed`: it ended the run, or it is a class that needs a fix whether or
	 * not the run survived it. `warning`: survived, or wasteful. `passed`:
	 * checked, nothing found. `skipped`: the instrumentation did not carry the
	 * signal.
	 */
	readonly status: SessionCheckStatus
	/** One sentence with the numbers in it, whatever the status. Identifiers —
	 *  tool names, fields — are spelled in backticks. */
	readonly headline: string
	/** What to do, as an imperative; only when something was found. */
	readonly action: string | undefined
	readonly fixArea: SessionFixArea | undefined
	/** The rows that are this check's evidence, each opening its span. */
	readonly findings: readonly SessionFinding[]
}

/** What the instrumentation gave the checks to work with: why a check was
 *  skipped, and what capturing more would unlock. */
export interface SessionCoverage {
	/** Some model call recorded its messages. */
	readonly messages: boolean
	/** Some tool call recorded its arguments or its result. */
	readonly toolPayloads: boolean
	readonly usage: SessionTokenReporting
	readonly cost: boolean
	readonly turns: TurnAnchorKind | undefined
}

export interface SessionChecksReport {
	readonly verdict: SessionVerdict
	/**
	 * What follows the verdict word: `the final turn died on the context
	 * window` after "Failed —", `with 2 warnings` or `cleanly — 12 checks
	 * passed across 21 turns` after "Completed". The outcome is not a check of
	 * its own: the check for whatever ended the run carries the evidence and
	 * the action, and this line names it.
	 */
	readonly headline: string
	readonly counts: Readonly<Record<SessionCheckStatus, number>>
	/** Failed first — the one that ended the run leading — then warnings,
	 *  passed, skipped; within a status, in the order the checks are defined,
	 *  so related rows sit together. */
	readonly checks: readonly SessionCheck[]
	readonly coverage: SessionCoverage
}

const STATUS_RANK = { failed: 0, warning: 1, passed: 2, skipped: 3 } satisfies Record<
	SessionCheckStatus,
	number
>

export function buildSessionChecks(
	turns: readonly SessionTurn[],
	summary: SessionSummary,
	report: SessionFindingsReport = buildSessionFindings(turns, summary),
): SessionChecksReport {
	// Turns may interleave in time (a fan-out stamps one conversation id per
	// lane), so "first call" and "last call" need the spans in start order.
	const spans = turns.flatMap((turn) => turn.spans).sort((a, b) => spanStartMs(a) - spanStartMs(b))
	const llmCalls = spans.filter(isLlmCall)
	const coverage = readCoverage(spans, summary, turns)

	const byKind = new Map<SessionFindingKind, SessionFinding[]>()
	for (const finding of report.findings) {
		const list = byKind.get(finding.kind) ?? []
		list.push(finding)
		byKind.set(finding.kind, list)
	}
	const of = (kind: SessionFindingKind): readonly SessionFinding[] => byKind.get(kind) ?? []
	const errors = of("error")

	const checks = [
		...completionCheck(of("incomplete")),
		contextWindowCheck(of("contextExceeded"), llmCalls),
		rateLimitCheck(of("rateLimited")),
		providerCheck(of("providerError"), of("providerRetry"), llmCalls.length),
		refusalCheck(of("refusal")),
		replyLengthCheck(of("truncation"), llmCalls),
		structuredOutputCheck(of("invalidOutput")),
		toolAvailabilityCheck(of("toolUnavailable"), summary),
		toolTimeoutCheck(of("toolTimeout"), summary),
		toolArgumentsCheck(of("toolArguments"), summary),
		toolErrorCheck(
			errors.filter((finding) => finding.tool !== undefined),
			summary,
		),
		...otherErrorsCheck(errors.filter((finding) => finding.tool === undefined)),
		repetitionCheck(of("repetition"), summary, coverage),
		stallCheck(of("stall")),
		promptCacheCheck(llmCalls),
	].sort(
		(a, b) =>
			STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
			// The check that ended the run leads: it is what the headline names.
			Number(endedTheRun(b.findings)) - Number(endedTheRun(a.findings)),
	)

	const counts = { failed: 0, warning: 0, passed: 0, skipped: 0 }
	for (const check of checks) counts[check.status]++

	return {
		verdict: report.verdict,
		headline: reportHeadline(report, turns, counts),
		counts,
		checks,
		coverage,
	}
}

/** A failed session is named by what killed it; one that completed is
 *  summarised by what the checks found, and by how much they looked at. */
function reportHeadline(
	report: SessionFindingsReport,
	turns: readonly SessionTurn[],
	counts: Readonly<Record<SessionCheckStatus, number>>,
): string {
	const word = turns[0]?.anchorKind === "trace" ? "segment" : "turn"
	if (report.verdict.status === "failed") {
		const cause = report.findings.find((finding) => finding.terminal)
		return `the final ${word} ${cause === undefined ? "did not close cleanly" : causeText(cause)}`
	}
	if (counts.failed > 0) return `but ${plural(counts.failed, "check")} failed`
	if (counts.warning > 0) return `with ${plural(counts.warning, "warning")}`
	return `cleanly — ${plural(counts.passed, "check")} passed across ${plural(turns.length, word)}`
}

function readCoverage(
	spans: readonly AiSessionSpan[],
	summary: SessionSummary,
	turns: readonly SessionTurn[],
): SessionCoverage {
	return {
		// JSON-decoded payloads: an emitter that wrote `null` lands as `null`,
		// not as a missing key, and recorded nothing.
		messages: spans.some(
			(span) =>
				(span.genAi.inputMessages ?? undefined) !== undefined ||
				(span.genAi.outputMessages ?? undefined) !== undefined,
		),
		toolPayloads: spans.some(
			(span) =>
				((span.genAi.toolCallArguments ?? undefined) !== undefined ||
					(span.genAi.toolCallResult ?? undefined) !== undefined) &&
				classifyAiSpan(span) === "tool",
		),
		usage: summary.tokenReporting,
		cost: summary.cost !== undefined,
		turns: turns[0]?.anchorKind,
	}
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

interface CheckIdentity {
	readonly id: string
	readonly name: string
	readonly fixArea: SessionFixArea | undefined
}

const check = (
	identity: CheckIdentity,
	status: SessionCheckStatus,
	headline: string,
	action?: string,
	findings: readonly SessionFinding[] = [],
): SessionCheck => ({
	...identity,
	status,
	headline,
	action,
	fixArea: status === "passed" || status === "skipped" ? undefined : identity.fixArea,
	findings,
})

/** The findings' own severity decides: a red row ended the run or names a
 *  class that needs a fix regardless; an amber one was survived. */
const foundStatus = (findings: readonly SessionFinding[]): "failed" | "warning" =>
	findings.some((finding) => finding.severity === "failure") ? "failed" : "warning"

const endedTheRun = (findings: readonly SessionFinding[]): boolean =>
	findings.some((finding) => finding.terminal)

/** A run that ended without the completion its agent demanded: present only
 *  when it happened, since most agents demand no such thing. */
function completionCheck(incomplete: readonly SessionFinding[]): SessionCheck[] {
	const unfinished = incomplete[0]
	if (unfinished === undefined) return []
	const identity: CheckIdentity = { id: "completion", name: "Completion", fixArea: "prompt" }
	return [
		check(
			identity,
			foundStatus(incomplete),
			// Ending without the completion tool is how the run ended; it did not
			// carry on past it, so the survived clause would mislead here.
			`A run ${unfinished.detail ?? "ended without calling its completion tool"} on ${where(unfinished)}`,
			"Give the agent a stop condition, or a larger turn budget; it ended without its completion tool.",
			incomplete,
		),
	]
}

/** How the final turn ended, per failure kind: `died on the context window`,
 *  `ended without calling \`submit_plan\``. Only a failure event can be the
 *  terminal finding, so the table covers exactly the failure kinds. */
const CAUSE_TEXT = {
	contextExceeded: () => "died on the context window",
	rateLimited: () => "died on a rate limit",
	providerError: () => "died on a provider error",
	refusal: () => "ended on a refusal",
	invalidOutput: () => "died on a reply that did not match its schema",
	incomplete: (finding) => finding.detail ?? "ended without calling its completion tool",
	toolUnavailable: (finding) => `died with ${toolName(finding)} unable to run`,
	toolTimeout: (finding) => `died on ${toolName(finding)} timing out`,
	toolArguments: (finding) => `died on ${toolName(finding)} rejecting its arguments`,
	error: (finding) =>
		finding.tool === undefined ? `died on \`${finding.label}\`` : `died on ${toolName(finding)} failing`,
} satisfies Record<SessionFailureKind, (finding: SessionFinding) => string>

const isFailureKind = (kind: SessionFindingKind): kind is SessionFailureKind => kind in CAUSE_TEXT

function causeText(finding: SessionFinding): string {
	return isFailureKind(finding.kind) ? CAUSE_TEXT[finding.kind](finding) : "did not close cleanly"
}

function contextWindowCheck(
	findings: readonly SessionFinding[],
	llmCalls: readonly AiSessionSpan[],
): SessionCheck {
	const identity: CheckIdentity = { id: "context-window", name: "Context window", fixArea: "prompt" }
	const found = findings[0]
	if (found !== undefined) {
		// The growth that matters is the one that ended in the overflow — up to
		// and including the call that overflowed, not what the session did
		// after it recovered. The row links the deepest span; the group's own
		// time is its first member's, which may be a wrapper that started
		// before that call.
		const overflow = llmCalls.find((span) => span.spanId === found.spanId)
		const untilMs = overflow === undefined ? found.atMs : spanStartMs(overflow)
		const sizes = promptSizes(llmCalls.filter((span) => spanStartMs(span) <= untilMs))
		const first = sizes[0]
		const last = sizes[sizes.length - 1]
		const growth =
			first !== undefined && last !== undefined && sizes.length > 1 && last > first
				? `; the prompt grew ${formatNumber(first)} → ${formatNumber(last)} tokens over the session`
				: ""
		return check(
			identity,
			foundStatus(findings),
			`The prompt outgrew the model's context window on ${where(found)}${growth}${carriedOn(findings)}`,
			"Compact or summarise the history before it nears the limit, or split the task across sessions.",
			findings,
		)
	}
	const sizes = promptSizes(llmCalls)
	if (sizes.length === 0) {
		return check(
			identity,
			"skipped",
			"No model call reported token usage, so prompt size could not be checked.",
		)
	}
	const peak = sizes.reduce((max, size) => (size > max ? size : max), 0)
	return check(identity, "passed", `The prompt peaked at ${formatNumber(peak)} tokens`)
}

/** Each model call's prompt, in start order: what the model had in front of
 *  it — uncached input plus both cache buckets. */
function promptSizes(llmCalls: readonly AiSessionSpan[]): readonly number[] {
	return llmCalls
		.map(spanTokenBuckets)
		.filter((buckets) => buckets !== undefined)
		.map((buckets) => buckets.input + buckets.cacheRead + buckets.cacheWrite)
		.filter((size) => size > 0)
}

function rateLimitCheck(findings: readonly SessionFinding[]): SessionCheck {
	const identity: CheckIdentity = { id: "rate-limits", name: "Rate limits", fixArea: "provider" }
	const found = findings[0]
	if (found === undefined) return check(identity, "passed", "No model call was rate-limited")
	const n = total(findings)
	return check(
		identity,
		foundStatus(findings),
		`${plural(n, "model call")} ${n === 1 ? "was" : "were"} rate-limited on ${where(found)}${carriedOn(findings)}`,
		"Add jittered backoff, or spread the load across API keys.",
		findings,
	)
}

function providerCheck(
	failures: readonly SessionFinding[],
	retries: readonly SessionFinding[],
	llmCalls: number,
): SessionCheck {
	const identity: CheckIdentity = { id: "provider", name: "Provider errors", fixArea: "provider" }
	const findings = [...failures, ...retries]
	if (findings.length === 0) {
		return check(
			identity,
			"passed",
			llmCalls === 0
				? "No model calls"
				: llmCalls === 1
					? "The one model call was answered first time"
					: `All ${plural(llmCalls, "model call")} were answered first time`,
		)
	}
	const parts = [
		...(failures.length > 0
			? [`${plural(total(failures), "model call")} failed at the provider on ${where(failures[0])}`]
			: []),
		...retries.map((retry) => `retried at the gateway: ${retry.detail ?? `${retry.count} attempts`}`),
	]
	return check(
		identity,
		failures.length > 0 ? foundStatus(failures) : "warning",
		parts.join("; ") + carriedOn(findings),
		"Add a fallback model or provider with backoff, and check the provider's status page.",
		findings,
	)
}

function refusalCheck(findings: readonly SessionFinding[]): SessionCheck {
	const identity: CheckIdentity = { id: "refusals", name: "Refusals", fixArea: "prompt" }
	const found = findings[0]
	if (found === undefined) return check(identity, "passed", "No reply was refused or filtered")
	const n = total(findings)
	return check(
		identity,
		foundStatus(findings),
		`${plural(n, "reply", "replies")} ${n === 1 ? "was" : "were"} refused or filtered on ${where(found)}${carriedOn(findings)}`,
		"Review what the model declined; adjust the prompt, or handle refusals in the agent.",
		findings,
	)
}

function replyLengthCheck(
	findings: readonly SessionFinding[],
	llmCalls: readonly AiSessionSpan[],
): SessionCheck {
	const identity: CheckIdentity = { id: "reply-length", name: "Reply length", fixArea: "model" }
	const found = findings[0]
	if (found !== undefined) {
		const n = total(findings)
		const limit = llmCalls.find((span) => span.spanId === found.spanId)?.genAi.requestMaxTokens
		return check(
			identity,
			foundStatus(findings),
			`${plural(n, "reply", "replies")} hit the output token limit${
				limit === undefined ? "" : ` (max_tokens ${formatNumber(limit)})`
			} on ${where(found)}`,
			"Raise max_tokens, or ask for shorter replies.",
			findings,
		)
	}
	if (!llmCalls.some((span) => span.genAi.responseFinishReasons !== undefined)) {
		return check(
			identity,
			"skipped",
			"No model call recorded a finish reason, so cut-off replies could not be checked.",
		)
	}
	return check(identity, "passed", "No reply hit its output limit")
}

function structuredOutputCheck(findings: readonly SessionFinding[]): SessionCheck {
	const identity: CheckIdentity = { id: "structured-output", name: "Structured output", fixArea: "prompt" }
	const found = findings[0]
	if (found === undefined) return check(identity, "passed", "No reply was rejected by a schema")
	const n = total(findings)
	return check(
		identity,
		foundStatus(findings),
		`${plural(n, "reply", "replies")} did not match the schema the agent demanded on ${where(found)}${detailText(found)}${carriedOn(findings)}`,
		"Add an example of the field to the prompt, or relax the schema.",
		findings,
	)
}

function toolAvailabilityCheck(findings: readonly SessionFinding[], summary: SessionSummary): SessionCheck {
	const identity: CheckIdentity = {
		id: "tool-availability",
		name: "Tool availability",
		fixArea: "integration",
	}
	if (findings.length === 0) {
		return check(
			identity,
			"passed",
			summary.tools.length === 0 ? "No tool was called" : "Every tool the agent called could run",
		)
	}
	return check(
		identity,
		foundStatus(findings),
		clauses(
			findings,
			(finding) => `${toolName(finding)} could not run on ${where(finding)}${detailText(finding)}`,
		) + carriedOn(findings),
		"Connect the integration or grant the permission the tool needs, then re-run.",
		findings,
	)
}

function toolTimeoutCheck(findings: readonly SessionFinding[], summary: SessionSummary): SessionCheck {
	const identity: CheckIdentity = { id: "tool-timeouts", name: "Tool timeouts", fixArea: "tool" }
	if (findings.length === 0) {
		const slowest = [...summary.tools].sort((a, b) => b.slowestMs - a.slowestMs)[0]
		return check(
			identity,
			"passed",
			slowest === undefined
				? "No tool was called"
				: `No tool call timed out; the slowest was \`${slowest.name}\` at ${formatSessionDuration(slowest.slowestMs)}`,
		)
	}
	return check(
		identity,
		foundStatus(findings),
		clauses(
			findings,
			(finding) =>
				`${toolName(finding)} timed out ${times(finding.count)} on ${where(finding)}${detailText(finding)}`,
		) + carriedOn(findings),
		"Raise the tool's timeout, or make the tool faster.",
		findings,
	)
}

function toolArgumentsCheck(findings: readonly SessionFinding[], summary: SessionSummary): SessionCheck {
	const identity: CheckIdentity = { id: "tool-arguments", name: "Tool arguments", fixArea: "tool" }
	if (findings.length === 0) {
		return check(
			identity,
			"passed",
			summary.tools.length === 0 ? "No tool was called" : "Every tool call was accepted as sent",
		)
	}
	const tools = [...new Set(findings.map(toolName))]
	return check(
		identity,
		foundStatus(findings),
		clauses(
			findings,
			(finding) =>
				`${toolName(finding)} rejected ${plural(finding.count, "call")} on ${where(finding)}${detailText(finding)}`,
		) + carriedOn(findings),
		`Tighten ${tools.join(", ")}'s description or schema so the model sends what it needs.`,
		findings,
	)
}

function toolErrorCheck(findings: readonly SessionFinding[], summary: SessionSummary): SessionCheck {
	const identity: CheckIdentity = { id: "tool-errors", name: "Tool errors", fixArea: "tool" }
	if (findings.length === 0) {
		const calls = summary.work.toolCalls
		// Failures the other tool checks classified — unavailable, timed out,
		// rejected arguments — are not this row's to deny.
		const failed = summary.tools.reduce((sum, tool) => sum + tool.failed, 0)
		return check(
			identity,
			"passed",
			calls === 0
				? "No tool was called"
				: failed === 0
					? `${plural(calls, "tool call")}, none failed`
					: `${plural(calls, "tool call")}; the ${failed === 1 ? "one that failed is" : `${failed} that failed are`} named by the checks above`,
		)
	}
	const single = findings.length === 1 ? findings[0] : undefined
	// One failure gets its line; several get the tools and where, and the
	// evidence rows carry each one's line — a sentence nesting three error
	// messages in parentheses was not readable.
	const first = findings[0]
	const sameTurn = findings.every((finding) => finding.turnText === first?.turnText)
	const headline =
		single !== undefined
			? `${toolName(single)} failed ${times(single.count)} on ${where(single)}${detailText(single)}`
			: sameTurn && first !== undefined
				? `${plural(total(findings), "tool call")} failed on ${where(first)}: ${clauses(
						findings,
						(finding) => `${toolName(finding)}${finding.count > 1 ? ` ×${finding.count}` : ""}`,
						", ",
					)}`
				: `${plural(total(findings), "tool call")} failed: ${clauses(
						findings,
						(finding) =>
							`${toolName(finding)}${finding.count > 1 ? ` ×${finding.count}` : ""} on ${where(finding)}`,
						", ",
					)}`
	return check(
		identity,
		foundStatus(findings),
		headline + carriedOn(findings),
		"Fix the tool, or make its error text say what to do next.",
		findings,
	)
}

/** Errored spans nothing classified and no tool owns: the catch-all row,
 *  present only when there is something in it. */
function otherErrorsCheck(findings: readonly SessionFinding[]): SessionCheck[] {
	if (findings.length === 0) return []
	const identity: CheckIdentity = { id: "other-errors", name: "Other errors", fixArea: undefined }
	return [
		check(
			identity,
			foundStatus(findings),
			clauses(
				findings,
				(finding) =>
					`\`${finding.label}\` ${times(finding.count)} on ${where(finding)}${detailText(finding)}`,
			) + carriedOn(findings),
			"Open the span for the framework's own message.",
			findings,
		),
	]
}

function repetitionCheck(
	findings: readonly SessionFinding[],
	summary: SessionSummary,
	coverage: SessionCoverage,
): SessionCheck {
	const identity: CheckIdentity = { id: "repetition", name: "Repeated calls", fixArea: "prompt" }
	if (findings.length === 0) {
		return check(
			identity,
			"passed",
			summary.tools.length === 0
				? "No tool was called"
				: coverage.toolPayloads
					? "No tool was called on repeat within a turn"
					: "No tool was hammered within a turn; arguments were not captured, so identical retries could not be checked",
		)
	}
	return check(
		identity,
		foundStatus(findings),
		clauses(
			findings,
			(finding) =>
				`${toolName(finding)} was ${finding.detail ?? "called repeatedly"} on ${where(finding)}`,
		),
		"Cache the result, or give the agent a stop rule; it repeated itself.",
		findings,
	)
}

function stallCheck(findings: readonly SessionFinding[]): SessionCheck {
	const identity: CheckIdentity = { id: "stalls", name: "Stalls", fixArea: "instrumentation" }
	if (findings.length === 0) return check(identity, "passed", "No gap over 30s inside a turn")
	return check(
		identity,
		foundStatus(findings),
		clauses(
			findings,
			(finding) => `Nothing ran for ${finding.label.replace(/^idle /, "")} inside ${where(finding)}`,
		),
		"Check what ran before the gap; untraced time inside a turn is usually a queue, a sleep or a wait for approval.",
		findings,
	)
}

function promptCacheCheck(llmCalls: readonly AiSessionSpan[]): SessionCheck {
	const identity: CheckIdentity = { id: "prompt-cache", name: "Prompt cache", fixArea: "prompt" }
	const reporting = llmCalls.filter(
		(span) =>
			span.genAi.usageCacheReadInputTokens !== undefined ||
			span.genAi.usageCacheCreationInputTokens !== undefined,
	)
	if (reporting.length === 0) {
		return check(
			identity,
			"skipped",
			"No model call reported cache usage, so the prompt cache could not be checked.",
		)
	}
	// The first call of a session cannot hit a cache nothing has written yet.
	const calls = reporting
		.slice(1)
		.map(spanTokenBuckets)
		.filter((buckets) => buckets !== undefined)
		.map((buckets) => ({
			read: buckets.cacheRead,
			prompt: buckets.input + buckets.cacheRead + buckets.cacheWrite,
		}))
		.filter((call) => call.prompt > 0)
	if (calls.length < CACHE_MIN_CALLS) {
		return check(
			identity,
			"skipped",
			`Only ${plural(reporting.length, "model call")} reported cache usage; at least ${CACHE_MIN_CALLS + 1} are needed to judge the prompt cache.`,
		)
	}
	const rate =
		calls.reduce((sum, call) => sum + call.read, 0) / calls.reduce((sum, call) => sum + call.prompt, 0)
	const misses = calls.filter((call) => call.read / call.prompt < CACHE_HIT_MIN_RATE).length
	const rateText = `${Math.round(rate * 100)}%`
	if (rate < CACHE_HIT_MIN_RATE) {
		return check(
			identity,
			"warning",
			`Cache hit rate ${rateText} over ${plural(calls.length, "call")}; ${misses} missed the cache`,
			"Keep the prompt prefix stable: system prompt and tool list first, nothing that changes every call at the top.",
		)
	}
	return check(identity, "passed", `Cache hit rate ${rateText} over ${plural(calls.length, "call")}`)
}

/* -------------------------------------------------------------------------- */
/* Phrasing                                                                   */
/* -------------------------------------------------------------------------- */

function plural(n: number, noun: string, nouns = `${noun}s`): string {
	return `${formatNumber(n)} ${n === 1 ? noun : nouns}`
}

function times(n: number): string {
	return n === 1 ? "once" : n === 2 ? "twice" : `${n}×`
}

function total(findings: readonly SessionFinding[]): number {
	return findings.reduce((sum, finding) => sum + finding.count, 0)
}

/** The first few findings phrased and joined, the rest counted: a session
 *  with two hundred repeated tools gets a sentence, not a page. */
function clauses(
	findings: readonly SessionFinding[],
	phrase: (finding: SessionFinding) => string,
	separator = "; ",
): string {
	const shown = findings.slice(0, HEADLINE_MAX_CLAUSES).map(phrase).join(separator)
	const rest = findings.length - HEADLINE_MAX_CLAUSES
	return rest > 0 ? `${shown}${separator}and ${rest} more` : shown
}

/** `turn 14 (final)`, `turns 9, 11` — the finding's own attribution, read in a sentence. */
function where(finding: SessionFinding): string {
	return finding.turnText.replace(/^(Turn|Segment)/, (word) => word.toLowerCase())
}

function toolName(finding: SessionFinding): string {
	return `\`${finding.tool ?? finding.label}\``
}

function detailText(finding: SessionFinding): string {
	return finding.detail === undefined ? "" : `: ${finding.detail}`
}

/** A failure the session survived says so: it is what separates a row worth
 *  a look from the thing that ended the run. */
function carriedOn(findings: readonly SessionFinding[]): string {
	return endedTheRun(findings) ? "" : "; the session carried on"
}
