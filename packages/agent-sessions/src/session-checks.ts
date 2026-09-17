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
import { spanTokenBuckets, type SessionSummary, type SessionTokenReporting } from "./session-summary"
import { classifyAiSpan, isLlmCall, type SessionTurn, type TurnAnchorKind } from "./session-turns"

/** Below this share of the prompt served from cache, across the calls after
 *  the first, the prefix is not being reused. */
const CACHE_HIT_MIN_RATE = 0.5
/** Fewer calls than this say nothing about the cache either way. */
const CACHE_MIN_CALLS = 3

export type SessionCheckStatus = "failed" | "warning" | "passed" | "skipped"

export type SessionCheckGroup = "outcome" | "model" | "tools" | "flow" | "efficiency"

/** What a fix would touch — the tag a reader filters on for what they own. */
export type SessionFixArea = "prompt" | "tool" | "integration" | "model" | "provider" | "instrumentation"

export interface SessionCheck {
	readonly id: string
	readonly group: SessionCheckGroup
	/** Plain English: `Context window`, `Tool arguments`. */
	readonly name: string
	/**
	 * `failed`: it affected the outcome, or it is a class that always needs a
	 * fix. `warning`: recovered from, or wasteful. `passed`: checked, nothing
	 * found. `skipped`: the instrumentation did not carry the signal.
	 */
	readonly status: SessionCheckStatus
	/** One sentence with the numbers in it, whatever the status. */
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
	/** The one line that answers "did it work": `The final turn died on the
	 *  context window`, `Completed with 2 warnings`. */
	readonly headline: string
	readonly counts: Readonly<Record<SessionCheckStatus, number>>
	/** Failed first, then warnings, passed, skipped; stable within a status. */
	readonly checks: readonly SessionCheck[]
	readonly coverage: SessionCoverage
}

const STATUS_RANK = { failed: 0, warning: 1, passed: 2, skipped: 3 } satisfies Record<SessionCheckStatus, number>

export function buildSessionChecks(
	turns: readonly SessionTurn[],
	summary: SessionSummary,
	report: SessionFindingsReport = buildSessionFindings(turns, summary),
): SessionChecksReport {
	const spans = turns.flatMap((turn) => turn.spans)
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
		outcomeCheck(report, turns, of("incomplete")),
		contextWindowCheck(of("contextExceeded"), llmCalls, coverage),
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
		repetitionCheck(of("repetition"), summary),
		stallCheck(of("stall")),
		promptCacheCheck(llmCalls),
	].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])

	const counts = { failed: 0, warning: 0, passed: 0, skipped: 0 }
	for (const check of checks) counts[check.status]++

	return {
		verdict: report.verdict,
		headline: reportHeadline(report.verdict, checks[0], counts),
		counts,
		checks,
		coverage,
	}
}

/** The failed outcome leads the list, so its headline is the report's; a
 *  session that completed is summarised by what the other checks found. */
function reportHeadline(
	verdict: SessionVerdict,
	first: SessionCheck,
	counts: Readonly<Record<SessionCheckStatus, number>>,
): string {
	if (verdict.status === "failed") return first.headline
	if (counts.failed > 0) return `Completed, but ${plural(counts.failed, "check")} failed`
	if (counts.warning > 0) return `Completed with ${plural(counts.warning, "warning")}`
	return `Completed cleanly — ${plural(counts.passed, "check")} passed`
}

function readCoverage(
	spans: readonly AiSessionSpan[],
	summary: SessionSummary,
	turns: readonly SessionTurn[],
): SessionCoverage {
	return {
		messages: spans.some(
			(span) => span.genAi.inputMessages !== undefined || span.genAi.outputMessages !== undefined,
		),
		toolPayloads: spans.some(
			(span) =>
				classifyAiSpan(span) === "tool" &&
				(span.genAi.toolCallArguments !== undefined || span.genAi.toolCallResult !== undefined),
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
	readonly group: SessionCheckGroup
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

/** A finding that killed the final turn fails its check; the same finding the
 *  session carried past is a warning. */
const foundStatus = (findings: readonly SessionFinding[]): SessionCheckStatus =>
	findings.some((finding) => finding.terminal) ? "failed" : "warning"

/**
 * The verdict as a check: it carries no evidence of its own, because the
 * check for whatever killed the session already does, and the page's verdict
 * has its own link to the failing span.
 */
function outcomeCheck(
	report: SessionFindingsReport,
	turns: readonly SessionTurn[],
	incomplete: readonly SessionFinding[],
): SessionCheck {
	const identity: CheckIdentity = { id: "completed", group: "outcome", name: "Completed", fixArea: undefined }
	const word = turns[0]?.anchorKind === "trace" ? "segment" : "turn"
	if (report.verdict.status === "failed") {
		const cause = report.findings.find((finding) => finding.terminal)
		return check(
			identity,
			"failed",
			`The final ${word} ${cause === undefined ? "did not close cleanly" : causeText(cause)}`,
		)
	}
	const unfinished = incomplete[0]
	if (unfinished !== undefined) {
		return check(
			identity,
			"failed",
			`A run ${unfinished.detail ?? "ended without calling its completion tool"} on ${where(unfinished)}`,
			"Give the agent a stop condition, or a larger turn budget; it ended without its completion tool.",
			incomplete,
		)
	}
	return check(
		identity,
		"passed",
		turns.length === 1 ? `The one ${word} closed cleanly` : `All ${turns.length} ${word}s closed cleanly`,
	)
}

/** `died on the context window`, `ended without calling \`submit_plan\``. */
function causeText(finding: SessionFinding): string {
	const tool = finding.tool === undefined ? undefined : `\`${finding.tool}\``
	switch (finding.kind) {
		case "contextExceeded":
			return "died on the context window"
		case "rateLimited":
			return "died on a rate limit"
		case "providerError":
			return "died on a provider error"
		case "refusal":
			return "ended on a refusal"
		case "invalidOutput":
			return "died on a reply that did not match its schema"
		case "incomplete":
			return finding.detail ?? "ended without calling its completion tool"
		case "toolUnavailable":
			return `died with ${tool} unable to run`
		case "toolTimeout":
			return `died on ${tool} timing out`
		case "toolArguments":
			return `died on ${tool} rejecting its arguments`
		case "error":
			return tool === undefined ? `died on \`${finding.label}\`` : `died on ${tool} failing`
		default:
			return "did not close cleanly"
	}
}

function contextWindowCheck(
	findings: readonly SessionFinding[],
	llmCalls: readonly AiSessionSpan[],
	coverage: SessionCoverage,
): SessionCheck {
	const identity: CheckIdentity = { id: "context-window", group: "model", name: "Context window", fixArea: "prompt" }
	const sizes = promptSizes(llmCalls)
	const first = sizes[0]
	const last = sizes[sizes.length - 1]
	const growth =
		first !== undefined && last !== undefined && sizes.length > 1 && last > first
			? `; the prompt grew ${formatNumber(first)} → ${formatNumber(last)} tokens over the session`
			: ""
	const found = findings[0]
	if (found !== undefined) {
		return check(
			identity,
			"failed",
			`The prompt outgrew the model's context window on ${where(found)}${growth}`,
			"Compact or summarise the history before it nears the limit, or split the task across sessions.",
			findings,
		)
	}
	if (coverage.usage === "none" || sizes.length === 0) {
		return check(identity, "skipped", "No model call reported token usage, so prompt size could not be checked.")
	}
	return check(identity, "passed", `The prompt peaked at ${formatNumber(Math.max(...sizes))} tokens`)
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
	const identity: CheckIdentity = { id: "rate-limits", group: "model", name: "Rate limits", fixArea: "provider" }
	const found = findings[0]
	if (found === undefined) return check(identity, "passed", "No model call was rate-limited")
	const status = foundStatus(findings)
	return check(
		identity,
		status,
		`${plural(total(findings), "model call")} ${total(findings) === 1 ? "was" : "were"} rate-limited on ${where(found)}${carriedOn(status)}`,
		"Add jittered backoff, or spread the load across API keys.",
		findings,
	)
}

function providerCheck(
	failures: readonly SessionFinding[],
	retries: readonly SessionFinding[],
	llmCalls: number,
): SessionCheck {
	const identity: CheckIdentity = { id: "provider", group: "model", name: "Provider errors", fixArea: "provider" }
	const findings = [...failures, ...retries]
	if (findings.length === 0) {
		return check(
			identity,
			"passed",
			llmCalls === 0 ? "No model calls" : `All ${plural(llmCalls, "model call")} were answered first time`,
		)
	}
	const status = failures.length > 0 ? foundStatus(failures) : "warning"
	const parts = [
		...(failures.length > 0
			? [
					`${plural(total(failures), "model call")} failed at the provider on ${where(failures[0])}${carriedOn(status)}`,
				]
			: []),
		...retries.map((retry) => `retried at the gateway: ${retry.detail ?? `${retry.count} attempts`}`),
	]
	return check(
		identity,
		status,
		parts.join("; "),
		"Add a fallback model or provider with backoff, and check the provider's status page.",
		findings,
	)
}

function refusalCheck(findings: readonly SessionFinding[]): SessionCheck {
	const identity: CheckIdentity = { id: "refusals", group: "model", name: "Refusals", fixArea: "prompt" }
	const found = findings[0]
	if (found === undefined) return check(identity, "passed", "No reply was refused or filtered")
	const status = foundStatus(findings)
	const n = total(findings)
	return check(
		identity,
		status,
		`${plural(n, "reply", "replies")} ${n === 1 ? "was" : "were"} refused or filtered on ${where(found)}${carriedOn(status)}`,
		"Review what the model declined; adjust the prompt, or handle refusals in the agent.",
		findings,
	)
}

function replyLengthCheck(findings: readonly SessionFinding[], llmCalls: readonly AiSessionSpan[]): SessionCheck {
	const identity: CheckIdentity = { id: "reply-length", group: "model", name: "Reply length", fixArea: "model" }
	const found = findings[0]
	if (found !== undefined) {
		const n = total(findings)
		const limit = llmCalls.find((span) => span.spanId === found.spanId)?.genAi.requestMaxTokens
		return check(
			identity,
			"warning",
			`${plural(n, "reply", "replies")} hit the output token limit${
				limit === undefined ? "" : ` (max_tokens ${formatNumber(limit)})`
			} on ${where(found)}`,
			"Raise max_tokens, or ask for shorter replies.",
			findings,
		)
	}
	if (!llmCalls.some((span) => span.genAi.responseFinishReasons !== undefined)) {
		return check(identity, "skipped", "No model call recorded a finish reason, so cut-off replies could not be checked.")
	}
	return check(identity, "passed", "No reply hit its output limit")
}

function structuredOutputCheck(findings: readonly SessionFinding[]): SessionCheck {
	const identity: CheckIdentity = { id: "structured-output", group: "model", name: "Structured output", fixArea: "prompt" }
	const found = findings[0]
	if (found === undefined) return check(identity, "passed", "No reply was rejected by a schema")
	const n = total(findings)
	return check(
		identity,
		"failed",
		`${plural(n, "reply", "replies")} did not match the schema the agent demanded on ${where(found)}${detailText(found)}`,
		"Add an example of the field to the prompt, or relax the schema.",
		findings,
	)
}

function toolAvailabilityCheck(findings: readonly SessionFinding[], summary: SessionSummary): SessionCheck {
	const identity: CheckIdentity = {
		id: "tool-availability",
		group: "tools",
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
		"failed",
		findings.map((finding) => `${toolName(finding)} could not run on ${where(finding)}${detailText(finding)}`).join("; "),
		"Connect the integration or grant the permission the tool needs, then re-run.",
		findings,
	)
}

function toolTimeoutCheck(findings: readonly SessionFinding[], summary: SessionSummary): SessionCheck {
	const identity: CheckIdentity = { id: "tool-timeouts", group: "tools", name: "Tool timeouts", fixArea: "tool" }
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
	const status = foundStatus(findings)
	return check(
		identity,
		status,
		findings
			.map((finding) => `${toolName(finding)} timed out ${times(finding.count)} on ${where(finding)}`)
			.join("; ") + carriedOn(status),
		"Raise the tool's timeout, or make the tool faster.",
		findings,
	)
}

function toolArgumentsCheck(findings: readonly SessionFinding[], summary: SessionSummary): SessionCheck {
	const identity: CheckIdentity = { id: "tool-arguments", group: "tools", name: "Tool arguments", fixArea: "tool" }
	if (findings.length === 0) {
		return check(
			identity,
			"passed",
			summary.tools.length === 0 ? "No tool was called" : "Every tool call was accepted as sent",
		)
	}
	const status = foundStatus(findings)
	const tools = [...new Set(findings.map(toolName))]
	return check(
		identity,
		status,
		findings
			.map(
				(finding) =>
					`${toolName(finding)} rejected ${plural(finding.count, "call")} on ${where(finding)}${detailText(finding)}`,
			)
			.join("; "),
		`Tighten ${tools.join(", ")}'s description or schema so the model sends what it needs.`,
		findings,
	)
}

function toolErrorCheck(findings: readonly SessionFinding[], summary: SessionSummary): SessionCheck {
	const identity: CheckIdentity = { id: "tool-errors", group: "tools", name: "Tool errors", fixArea: "tool" }
	if (findings.length === 0) {
		const calls = summary.tools.reduce((sum, tool) => sum + tool.calls, 0)
		return check(
			identity,
			"passed",
			calls === 0 ? "No tool was called" : `${plural(calls, "tool call")}, none failed`,
		)
	}
	const status = foundStatus(findings)
	const n = total(findings)
	const single = findings.length === 1 ? findings[0] : undefined
	const headline =
		single !== undefined
			? `${toolName(single)} failed ${times(single.count)} on ${where(single)}${detailText(single)}${carriedOn(status)}`
			: `${plural(n, "tool call")} failed${status === "warning" ? " and the agent carried on" : ""}: ${findings
					.map((finding) => `${toolName(finding)} (${finding.detail ?? finding.label}, ${where(finding)})`)
					.join(", ")}`
	return check(
		identity,
		status,
		headline,
		"Fix the tool, or make its error text say what to do next.",
		findings,
	)
}

/** Errored spans nothing classified and no tool owns: the catch-all row,
 *  present only when there is something in it. */
function otherErrorsCheck(findings: readonly SessionFinding[]): SessionCheck[] {
	if (findings.length === 0) return []
	const identity: CheckIdentity = { id: "other-errors", group: "outcome", name: "Other errors", fixArea: undefined }
	const status = foundStatus(findings)
	return [
		check(
			identity,
			status,
			findings
				.map((finding) => `\`${finding.label}\` ${times(finding.count)} on ${where(finding)}${detailText(finding)}`)
				.join("; ") + carriedOn(status),
			"Open the span for the framework's own message.",
			findings,
		),
	]
}

function repetitionCheck(findings: readonly SessionFinding[], summary: SessionSummary): SessionCheck {
	const identity: CheckIdentity = { id: "repetition", group: "flow", name: "Repeated calls", fixArea: "prompt" }
	if (findings.length === 0) {
		return check(
			identity,
			"passed",
			summary.tools.length === 0 ? "No tool was called" : "No tool was called on repeat within a turn",
		)
	}
	return check(
		identity,
		"warning",
		findings
			.map((finding) => `${toolName(finding)} was ${finding.detail ?? "called repeatedly"} on ${where(finding)}`)
			.join("; "),
		"Cache the result, or give the agent a stop rule; it repeated itself.",
		findings,
	)
}

function stallCheck(findings: readonly SessionFinding[]): SessionCheck {
	const identity: CheckIdentity = { id: "stalls", group: "flow", name: "Stalls", fixArea: "instrumentation" }
	if (findings.length === 0) return check(identity, "passed", "No gap over 30s inside a turn")
	return check(
		identity,
		"warning",
		findings
			.map((finding) => `Nothing ran for ${finding.label.replace(/^idle /, "")} inside ${where(finding)}`)
			.join("; "),
		"Check what ran before the gap; untraced time inside a turn is usually a queue, a sleep or a wait for approval.",
		findings,
	)
}

function promptCacheCheck(llmCalls: readonly AiSessionSpan[]): SessionCheck {
	const identity: CheckIdentity = { id: "prompt-cache", group: "efficiency", name: "Prompt cache", fixArea: "prompt" }
	const reporting = llmCalls.filter(
		(span) =>
			span.genAi.usageCacheReadInputTokens !== undefined ||
			span.genAi.usageCacheCreationInputTokens !== undefined,
	)
	if (reporting.length === 0) {
		return check(identity, "skipped", "No model call reported cache usage, so the prompt cache could not be checked.")
	}
	// The first call of a session cannot hit a cache nothing has written yet.
	const calls = reporting
		.slice(1)
		.map(spanTokenBuckets)
		.filter((buckets) => buckets !== undefined)
		.map((buckets) => ({ read: buckets.cacheRead, prompt: buckets.input + buckets.cacheRead + buckets.cacheWrite }))
		.filter((call) => call.prompt > 0)
	if (calls.length < CACHE_MIN_CALLS) {
		return check(
			identity,
			"skipped",
			`Only ${plural(reporting.length, "model call")} reported cache usage — too few to judge the prompt cache.`,
		)
	}
	const rate = calls.reduce((sum, call) => sum + call.read, 0) / calls.reduce((sum, call) => sum + call.prompt, 0)
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

function carriedOn(status: SessionCheckStatus): string {
	return status === "warning" ? "; the session carried on" : ""
}
