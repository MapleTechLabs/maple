// Two boards' worth of synthetic agent traffic, for `/lab/agent-overview` and
// for the view's own test.
//
// `ai_trace_index` does not exist in the local Tinybird container, so the real
// page has nothing to draw locally; this is where its layout gets looked at.
//
// Every figure is built from PER-SESSION rates rather than typed in as totals,
// so the counts, the ratios and the rates in a bucket can never contradict each
// other the way hand-written fixture numbers do. The scenarios are the two the
// design was drawn for: a healthy week, and a day with a step change at 14:00
// UTC that the movers rail is supposed to find.
//
// The filters are NOT applied to these numbers — the lab writes them to local
// state so every control, chip and row highlight works, and the readings stay
// put so a layout change is the only thing that moves on screen.

import { formatWarehouseDateTime } from "@maple/query-engine"

import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"
import {
	EMPTY_OVERVIEW_MEASURES,
	type AgentOverviewInput,
	type OverviewBreakdownEntry,
	type OverviewMeasurePoint,
	type OverviewMeasures,
	type OverviewModelMixRow,
} from "@/lib/agent-sessions/overview-analytics"
import {
	OVERVIEW_DIMENSIONS,
	type OverviewDimension,
	type OverviewFacets,
} from "@/lib/agent-sessions/overview-search"
import type { OverviewTopSessionTab } from "@/lib/agent-sessions/use-agent-overview"

export const OVERVIEW_SCENARIOS = ["healthy7d", "regression24h"] as const
export type OverviewScenario = (typeof OVERVIEW_SCENARIOS)[number]

export interface OverviewFixture {
	readonly scenario: OverviewScenario
	readonly windowLabel: string
	readonly window: { readonly startTime: string; readonly endTime: string }
	/** Ready for `buildAgentOverviewData`, minus the `compare` the lab owns. */
	readonly input: Omit<AgentOverviewInput, "compare">
	readonly facets: OverviewFacets
	readonly topSessions: Record<OverviewTopSessionTab, ReadonlyArray<AgentSessionRow>>
}

/* -------------------------------------------------------------------------------------------------
 * Shapes
 * -----------------------------------------------------------------------------------------------*/

/** One bucket's behaviour, as a reader would describe it. */
interface SessionRates {
	sessions: number
	/** Sessions with at least one failed span, 0–1. */
	errorRate: number
	llmPerSession: number
	/** Model-call SPANS per netted call — gateway mirrors and wrapper roll-ups. */
	spanFactor: number
	llmErrorRate: number
	toolsPerSession: number
	toolErrorRate: number
	costPerSession: number
	tokensPerSession: number
	/** Cache reads over everything that could have been a prompt read, 0–1. */
	cacheShare: number
	pricedShare: number
	p50Ms: number
	p95Ms: number
	llmP50Ms: number
	llmP95Ms: number
}

const HEALTHY: SessionRates = {
	sessions: 114,
	errorRate: 0.024,
	llmPerSession: 8.4,
	spanFactor: 1.18,
	llmErrorRate: 0.019,
	toolsPerSession: 6.3,
	toolErrorRate: 0.031,
	costPerSession: 0.264,
	tokensPerSession: 67_400,
	cacheShare: 0.71,
	pricedShare: 0.94,
	p50Ms: 42_000,
	p95Ms: 96_000,
	llmP50Ms: 1_900,
	llmP95Ms: 7_400,
}

/** The step the investigating board is drawn around. Sessions barely move. */
const REGRESSED: SessionRates = {
	...HEALTHY,
	errorRate: 0.26,
	llmErrorRate: 0.161,
	toolsPerSession: 15.8,
	toolErrorRate: 0.19,
	costPerSession: 0.378,
	tokensPerSession: 118_000,
	cacheShare: 0.12,
	p95Ms: 227_000,
	llmP50Ms: 3_100,
	llmP95Ms: 18_600,
}

/** A deterministic wobble, so a board looks like traffic and not like a ruler. */
const wobble = (index: number, amplitude: number): number =>
	1 + amplitude * Math.sin(index * 1.7) + (amplitude / 2) * Math.sin(index * 0.53)

const scaleRates = (rates: SessionRates, index: number): SessionRates => ({
	...rates,
	sessions: Math.round(rates.sessions * wobble(index, 0.18)),
	costPerSession: rates.costPerSession * wobble(index, 0.09),
	tokensPerSession: rates.tokensPerSession * wobble(index, 0.07),
	toolsPerSession: rates.toolsPerSession * wobble(index, 0.08),
	errorRate: rates.errorRate * wobble(index, 0.22),
	llmErrorRate: rates.llmErrorRate * wobble(index, 0.2),
	p95Ms: rates.p95Ms * wobble(index, 0.11),
})

/**
 * One bucket's rates, as the API would report them.
 *
 * The token split is disjoint and adds to the total, and `cacheShare` is
 * exactly the ratio the cache-hit chart divides — the numbers agree because
 * they come from one place.
 */
function measuresOf(rates: SessionRates): OverviewMeasures {
	const sessions = Math.max(0, Math.round(rates.sessions))
	const llmCalls = Math.round(sessions * rates.llmPerSession)
	const llmCallSpans = Math.round(llmCalls * rates.spanFactor)
	const toolCalls = Math.round(sessions * rates.toolsPerSession)
	const tokens = Math.round(sessions * rates.tokensPerSession)
	const prompt = tokens * 0.78
	return {
		...EMPTY_OVERVIEW_MEASURES,
		sessions,
		erroredSessions: Math.round(sessions * rates.errorRate),
		llmCalls,
		llmCallSpans,
		erroredLlmCalls: Math.round(llmCallSpans * rates.llmErrorRate),
		toolCalls,
		erroredToolCalls: Math.round(toolCalls * rates.toolErrorRate),
		cost: Number((sessions * rates.costPerSession).toFixed(2)),
		pricedLlmCalls: Math.round(llmCallSpans * rates.pricedShare),
		tokens,
		inputTokens: Math.round(prompt * (1 - rates.cacheShare)),
		cacheReadTokens: Math.round(prompt * rates.cacheShare),
		cacheWriteTokens: Math.round(tokens * 0.04),
		outputTokens: Math.round(tokens * 0.12),
		reasoningTokens: Math.round(tokens * 0.06),
		sessionDurationP50Ms: rates.p50Ms,
		sessionDurationP95Ms: rates.p95Ms,
		llmDurationP50Ms: rates.llmP50Ms,
		llmDurationP95Ms: rates.llmP95Ms,
	}
}

/** Counts sum; quantiles do not, so the window's own are passed in. */
function foldMeasures(
	points: ReadonlyArray<OverviewMeasures>,
	quantiles: Pick<
		OverviewMeasures,
		| "sessionDurationP50Ms"
		| "sessionDurationP95Ms"
		| "llmDurationP50Ms"
		| "llmDurationP95Ms"
	>,
): OverviewMeasures {
	const sum = points.reduce<OverviewMeasures>(
		(total, point) => ({
			...total,
			sessions: total.sessions + point.sessions,
			erroredSessions: total.erroredSessions + point.erroredSessions,
			llmCalls: total.llmCalls + point.llmCalls,
			llmCallSpans: total.llmCallSpans + point.llmCallSpans,
			erroredLlmCalls: total.erroredLlmCalls + point.erroredLlmCalls,
			toolCalls: total.toolCalls + point.toolCalls,
			erroredToolCalls: total.erroredToolCalls + point.erroredToolCalls,
			cost: total.cost + point.cost,
			pricedLlmCalls: total.pricedLlmCalls + point.pricedLlmCalls,
			tokens: total.tokens + point.tokens,
			inputTokens: total.inputTokens + point.inputTokens,
			cacheReadTokens: total.cacheReadTokens + point.cacheReadTokens,
			cacheWriteTokens: total.cacheWriteTokens + point.cacheWriteTokens,
			outputTokens: total.outputTokens + point.outputTokens,
			reasoningTokens: total.reasoningTokens + point.reasoningTokens,
		}),
		EMPTY_OVERVIEW_MEASURES,
	)
	return { ...sum, cost: Number(sum.cost.toFixed(2)), ...quantiles }
}

/* -------------------------------------------------------------------------------------------------
 * Breakdowns
 * -----------------------------------------------------------------------------------------------*/

/** One key's story: its share of the window, and what it did differently. */
interface KeyStory {
	key: string
	share: number
	current?: Partial<SessionRates>
	previous?: Partial<SessionRates>
}

const stories = (...entries: ReadonlyArray<KeyStory>) => entries

const STORIES = {
	model: stories(
		{
			key: "claude-opus-5",
			share: 0.42,
			// The regression the rail is supposed to put first.
			current: { llmErrorRate: 0.161, costPerSession: 0.41 },
			previous: { llmErrorRate: 0.019, costPerSession: 0.29 },
		},
		{ key: "gpt-5.5", share: 0.23 },
		{ key: "claude-sonnet-5", share: 0.16, current: { costPerSession: 0.09 } },
		{ key: "gemini-3-pro", share: 0.11, current: { tokensPerSession: 94_000 } },
		{ key: "gpt-5.6", share: 0.05 },
		{ key: "llama-4-70b", share: 0.03, current: { costPerSession: 0.004 } },
	),
	agent: stories(
		{
			key: "release-captain",
			share: 0.31,
			current: { toolsPerSession: 15.8, errorRate: 0.24 },
			previous: { toolsPerSession: 6.1, errorRate: 0.022 },
		},
		{ key: "code-reviewer", share: 0.27 },
		{ key: "docs-writer", share: 0.18, current: { tokensPerSession: 122_000 } },
		{ key: "triage-bot", share: 0.14 },
		{ key: "", share: 0.1 },
	),
	service: stories(
		{ key: "api", share: 0.46, current: { p95Ms: 188_000 }, previous: { p95Ms: 94_000 } },
		{ key: "worker", share: 0.29 },
		{ key: "cli", share: 0.17 },
		{ key: "landing", share: 0.08 },
	),
	framework: stories(
		{ key: "eve", share: 0.58 },
		{ key: "openrouter", share: 0.24, current: { costPerSession: 0.39 } },
		{ key: "langchain", share: 0.13 },
		{ key: "vercel-ai", share: 0.05 },
	),
	environment: stories(
		{
			key: "production",
			share: 0.64,
			current: { errorRate: 0.19 },
			previous: { errorRate: 0.021 },
		},
		{ key: "staging", share: 0.26 },
		{ key: "development", share: 0.1 },
	),
	tool: stories(
		{
			key: "run_tests",
			share: 0.34,
			current: { toolErrorRate: 0.28, toolsPerSession: 9.4 },
			previous: { toolErrorRate: 0.04, toolsPerSession: 3.6 },
		},
		{ key: "read_file", share: 0.26 },
		{ key: "search_code", share: 0.19 },
		{ key: "apply_patch", share: 0.13, current: { toolErrorRate: 0.09 } },
		{ key: "web_fetch", share: 0.08 },
	),
} satisfies Record<OverviewDimension, ReadonlyArray<KeyStory>>

/**
 * One dimension's rows.
 *
 * The stories above are the REGRESSED board's; a healthy week gets a small
 * deterministic drift per key instead, so its movers rail has the handful of
 * modest moves a healthy week actually has rather than a copy of the outage.
 */
function breakdownEntries(
	dimension: OverviewDimension,
	current: SessionRates,
	previous: SessionRates,
	regressed: boolean,
): ReadonlyArray<OverviewBreakdownEntry> {
	// Seeded per dimension as well as per row, so six tables do not print six
	// copies of one key's drift and the rail ranks six different things.
	const seed = OVERVIEW_DIMENSIONS.indexOf(dimension) * 7
	const drift = (rates: SessionRates, at: number): Partial<SessionRates> => ({
		costPerSession: rates.costPerSession * wobble(seed + at, 0.16),
		tokensPerSession: rates.tokensPerSession * wobble(seed + at + 2, 0.24),
		errorRate: rates.errorRate * wobble(seed + at + 1, 0.3),
		toolsPerSession: rates.toolsPerSession * wobble(seed + at + 3, 0.18),
	})
	return STORIES[dimension].map((story, index) => ({
		key: story.key,
		current: measuresOf({
			...current,
			sessions: current.sessions * story.share,
			...drift(current, index * 2),
			...(regressed ? story.current : undefined),
		}),
		previous: measuresOf({
			...previous,
			sessions: previous.sessions * story.share,
			...drift(previous, index * 2 + 11),
			...(regressed ? story.previous : undefined),
		}),
	}))
}

/* -------------------------------------------------------------------------------------------------
 * Model mix
 * -----------------------------------------------------------------------------------------------*/

/** Seven models, so the sixth and the seventh fold into the `other` band. */
const MIX_MODELS = [
	{ model: "claude-opus-5", base: 0.34, regressed: 0.62 },
	{ model: "gpt-5.5", base: 0.24, regressed: 0.14 },
	{ model: "claude-sonnet-5", base: 0.16, regressed: 0.09 },
	{ model: "gemini-3-pro", base: 0.12, regressed: 0.07 },
	{ model: "gpt-5.6", base: 0.07, regressed: 0.04 },
	{ model: "llama-4-70b", base: 0.04, regressed: 0.02 },
	{ model: "mistral-large-3", base: 0.03, regressed: 0.02 },
] as const

function modelMixRows(
	buckets: ReadonlyArray<{ bucket: number; spans: number; regressed: boolean }>,
): ReadonlyArray<OverviewModelMixRow> {
	return buckets.flatMap(({ bucket, spans, regressed }, index) =>
		MIX_MODELS.map((model) => ({
			bucket,
			model: model.model,
			llmCallSpans: Math.max(
				1,
				Math.round(spans * (regressed ? model.regressed : model.base) * wobble(index, 0.06)),
			),
		})),
	)
}

/* -------------------------------------------------------------------------------------------------
 * Top sessions
 * -----------------------------------------------------------------------------------------------*/

const SESSION_SEEDS = [
	{ agent: "release-captain", model: "claude-opus-5", service: "api", vendor: "eve" },
	{ agent: "code-reviewer", model: "gpt-5.5", service: "api", vendor: "openrouter" },
	{ agent: "docs-writer", model: "gemini-3-pro", service: "worker", vendor: "eve" },
	{ agent: "triage-bot", model: "claude-sonnet-5", service: "worker", vendor: "langchain" },
	{ agent: "release-captain", model: "claude-opus-5", service: "cli", vendor: "eve" },
	{ agent: "code-reviewer", model: "gpt-5.6", service: "api", vendor: "vercel-ai" },
] as const

function topSessions(
	tab: OverviewTopSessionTab,
	endMs: number,
	rates: SessionRates,
): ReadonlyArray<AgentSessionRow> {
	return SESSION_SEEDS.map((seed, index) => {
		const rank = SESSION_SEEDS.length - index
		const startMs = endMs - (index + 1) * 37 * 60_000
		const durationMs =
			tab === "duration" ? rates.p95Ms * (1.6 + index * 0.2) : rates.p50Ms * (1 + index * 0.1)
		const errors = tab === "errored" ? rank * 3 : index === 0 ? 2 : 0
		const llmCalls = Math.round(rates.llmPerSession * (tab === "cost" ? rank * 1.6 : 1.2))
		return {
			sessionId: `${seed.agent}-${(2261 + index * 17).toString(16)}`,
			vendorId: seed.vendor,
			traceCount: 1 + (index % 3),
			spanCount: 40 + index * 11,
			errorSpanCount: errors,
			toolErrorCount: Math.round(errors * 0.6),
			turnErrorCount: errors - Math.round(errors * 0.6),
			serviceNames: [seed.service],
			models: [seed.model],
			agentNames: [seed.agent],
			firstAgentName: seed.agent,
			llmCalls,
			toolCalls: Math.round(rates.toolsPerSession * (tab === "cost" ? rank : 1.4)),
			totalTokens: Math.round(rates.tokensPerSession * (tab === "cost" ? rank * 1.4 : 1.1)),
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
			reasoningTokens: 0,
			cost: Number((rates.costPerSession * (tab === "cost" ? rank * 2.4 : 1.3)).toFixed(2)),
			startTime: formatWarehouseDateTime(startMs),
			endTime: formatWarehouseDateTime(startMs + durationMs),
			durationMs: Math.round(durationMs),
			hasDetails: true,
		}
	})
}

/* -------------------------------------------------------------------------------------------------
 * The scenarios
 * -----------------------------------------------------------------------------------------------*/

const HOUR_MS = 60 * 60_000

/** The hour the investigating board's step happens, in UTC so a board looks the
 *  same wherever it is opened. */
export const OVERVIEW_REGRESSION_HOUR_UTC = 14

interface ScenarioSpec {
	readonly windowLabel: string
	readonly bucketSeconds: number
	readonly buckets: number
	readonly current: SessionRates
	readonly previous: SessionRates
	/** True where the bucket is past the step. Healthy weeks have none. */
	readonly regressedAt: (bucketMs: number) => boolean
}

const SPECS = {
	healthy7d: {
		windowLabel: "7d",
		bucketSeconds: 6 * 3_600,
		buckets: 28,
		current: HEALTHY,
		previous: { ...HEALTHY, sessions: 121, costPerSession: 0.276, errorRate: 0.027 },
		regressedAt: (_bucketMs: number) => false,
	},
	regression24h: {
		windowLabel: "24h",
		bucketSeconds: 3_600,
		buckets: 24,
		current: { ...HEALTHY, sessions: 52 },
		previous: { ...HEALTHY, sessions: 51 },
		regressedAt: (bucketMs: number) =>
			new Date(bucketMs).getUTCHours() >= OVERVIEW_REGRESSION_HOUR_UTC,
	},
} satisfies Record<OverviewScenario, ScenarioSpec>

/**
 * One board's worth of data, from one frozen timestamp.
 *
 * The window ends on the hour so the regression scenario's buckets line up with
 * the step it is drawn around.
 */
export function buildOverviewFixture(scenario: OverviewScenario, nowMs: number): OverviewFixture {
	const spec = SPECS[scenario]
	const bucketMs = spec.bucketSeconds * 1_000
	const endMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
	const startMs = endMs - spec.buckets * bucketMs
	const windowMs = endMs - startMs

	const buckets = Array.from({ length: spec.buckets }, (_, index) => {
		const bucket = startMs + index * bucketMs
		const regressed = spec.regressedAt(bucket)
		return { bucket, index, regressed }
	})

	const series: ReadonlyArray<OverviewMeasurePoint> = buckets.map(
		({ bucket, index, regressed }) => ({
			bucket,
			...measuresOf(
				scaleRates(
					regressed ? { ...REGRESSED, sessions: spec.current.sessions } : spec.current,
					index,
				),
			),
		}),
	)
	const previousSeries: ReadonlyArray<OverviewMeasurePoint> = buckets.map(
		({ bucket, index }) => ({
			bucket: bucket - windowMs,
			...measuresOf(scaleRates(spec.previous, index + 3)),
		}),
	)

	// The regressed scenario's window mixes both shapes, so the tiles read the
	// whole window while the grid shows where it turned.
	const regressedShare = buckets.filter((b) => b.regressed).length / spec.buckets
	const blend = (healthy: number, bad: number) =>
		healthy * (1 - regressedShare) + bad * regressedShare
	const currentRates: SessionRates = {
		...spec.current,
		errorRate: blend(spec.current.errorRate, REGRESSED.errorRate),
		llmErrorRate: blend(spec.current.llmErrorRate, REGRESSED.llmErrorRate),
		toolsPerSession: blend(spec.current.toolsPerSession, REGRESSED.toolsPerSession),
		toolErrorRate: blend(spec.current.toolErrorRate, REGRESSED.toolErrorRate),
		costPerSession: blend(spec.current.costPerSession, REGRESSED.costPerSession),
		cacheShare: blend(spec.current.cacheShare, REGRESSED.cacheShare),
		p95Ms: blend(spec.current.p95Ms, REGRESSED.p95Ms),
	}

	const current = foldMeasures(series, {
		sessionDurationP50Ms: currentRates.p50Ms,
		sessionDurationP95Ms: currentRates.p95Ms,
		llmDurationP50Ms: currentRates.llmP50Ms,
		llmDurationP95Ms: currentRates.llmP95Ms,
	})
	const previous = foldMeasures(previousSeries, {
		sessionDurationP50Ms: spec.previous.p50Ms,
		sessionDurationP95Ms: spec.previous.p95Ms,
		llmDurationP50Ms: spec.previous.llmP50Ms,
		llmDurationP95Ms: spec.previous.llmP95Ms,
	})

	// Breakdown rows are measured over the WINDOW, like the tiles above them —
	// a table summing to a fraction of the strip would read as a bug.
	const breakdownCurrent: SessionRates = { ...currentRates, sessions: current.sessions }
	const breakdownPrevious: SessionRates = { ...spec.previous, sessions: previous.sessions }
	const breakdowns = OVERVIEW_DIMENSIONS.map((dimension) => {
		const entries = breakdownEntries(
			dimension,
			breakdownCurrent,
			breakdownPrevious,
			regressedShare > 0,
		)
		return { dimension, entries, totalKeys: entries.length + (dimension === "tool" ? 9 : 4) }
	})

	const facetsFor = (dimension: OverviewDimension) =>
		STORIES[dimension]
			.filter((story) => story.key !== "")
			.map((story) => ({
				name: story.key,
				count: Math.round(current.sessions * story.share),
			}))
	const facets: OverviewFacets = {
		model: facetsFor("model"),
		agent: facetsFor("agent"),
		service: facetsFor("service"),
		framework: facetsFor("framework"),
		environment: facetsFor("environment"),
		tool: facetsFor("tool"),
	}

	return {
		scenario,
		windowLabel: spec.windowLabel,
		window: {
			startTime: formatWarehouseDateTime(startMs),
			endTime: formatWarehouseDateTime(endMs),
		},
		input: {
			current,
			previous,
			series,
			previousSeries,
			modelMix: modelMixRows(
				buckets.map(({ bucket, index, regressed }) => ({
					bucket,
					spans: series[index].llmCallSpans,
					regressed,
				})),
			),
			breakdowns,
			bucketSeconds: spec.bucketSeconds,
			windowMs: { startMs, endMs },
			windowLabel: spec.windowLabel,
		},
		facets,
		topSessions: {
			cost: topSessions("cost", endMs, currentRates),
			duration: topSessions("duration", endMs, currentRates),
			errored: topSessions("errored", endMs, currentRates),
		},
	}
}
