// A week of tool calls with no warehouse behind it, for `/lab/agent-tools`.
//
// The fixture is a flat list of `(bucket, tool, model)` cells and a list of
// sessions; everything the page renders — series, totals, both breakdowns, the
// comparison window — is derived from them under the current scope. That is
// what makes the lab a real rehearsal rather than a screenshot: clicking a tool
// row re-derives the model panel, the chart and the sessions list exactly as
// the API would, so a selection bug shows up here.
//
// Shapes worth having in view when the page is looked at: a dominant tool that
// never fails, a rare tool that fails half the time, a tool whose p95 is thirty
// times its p50, a model that is fast and wrong, a tool name too long for its
// column, a tool called by one model only, and a tail long enough to exercise
// the `Other` fold.

import type { AiToolsSeriesKind } from "@maple/domain/http"

import {
	EMPTY_MEASURES,
	type ToolBreakdownRow,
	type ToolMeasures,
	type ToolSeriesPoint,
	type ToolSessionRow,
	type ToolTotals,
} from "@/lib/agent-sessions/tool-analytics"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"
import type { AgentToolsViewData } from "@/components/agent-sessions/tools/agent-tools-view"

const HOUR = 3_600_000
const BUCKET_MS = 3 * HOUR
const BUCKETS = 56
/** Nanoseconds per millisecond — the fixture is written in ms, the view model is ns. */
const MS = 1_000_000

interface ToolProfile {
	readonly name: string
	readonly service: string
	readonly env: string
	/** Calls per bucket at the profile's baseline. */
	readonly rate: number
	readonly errorRate: number
	readonly p50Ms: number
	/** Tail multiplier on p50 — 30 is the "usually instant, sometimes hangs" shape. */
	readonly tail: number
	readonly models: ReadonlyArray<string>
}

const PROFILES: ReadonlyArray<ToolProfile> = [
	{
		name: "read_file",
		service: "maple-slack-agent",
		env: "production",
		rate: 42,
		errorRate: 0.002,
		p50Ms: 8,
		tail: 4,
		models: ["claude-sonnet-5", "claude-opus-5"],
	},
	{
		name: "bash",
		service: "maple-slack-agent",
		env: "production",
		rate: 26,
		errorRate: 0.06,
		p50Ms: 220,
		tail: 30,
		models: ["claude-sonnet-5", "claude-opus-5", "openai/gpt-5.6"],
	},
	{
		name: "run_tests",
		service: "ci-runner",
		env: "production",
		rate: 9,
		errorRate: 0.21,
		p50Ms: 41_000,
		tail: 6,
		models: ["claude-opus-5", "openai/gpt-5.6"],
	},
	{
		name: "search_source_code",
		service: "research-worker",
		env: "staging",
		rate: 14,
		errorRate: 0.01,
		p50Ms: 380,
		tail: 9,
		models: ["claude-sonnet-5", "gemini-3-pro"],
	},
	{
		name: "deploy_preview_environment_and_wait",
		service: "ci-runner",
		env: "staging",
		rate: 3,
		errorRate: 0.44,
		p50Ms: 96_000,
		tail: 3,
		models: ["claude-opus-5"],
	},
	{
		name: "web_fetch",
		service: "research-worker",
		env: "production",
		rate: 6,
		errorRate: 0.11,
		p50Ms: 1_400,
		tail: 12,
		models: ["gemini-3-pro", "openai/gpt-5.6"],
	},
	{
		name: "grep",
		service: "maple-slack-agent",
		env: "production",
		rate: 4,
		errorRate: 0,
		p50Ms: 30,
		tail: 3,
		models: ["claude-sonnet-5"],
	},
	{
		name: "list_dashboards",
		service: "api",
		env: "production",
		rate: 2,
		errorRate: 0,
		p50Ms: 120,
		tail: 2,
		models: ["claude-sonnet-5"],
	},
]

/** Deterministic pseudo-noise: a fixture that changed on reload is useless for review. */
function wobble(seed: number): number {
	const x = Math.sin(seed * 12.9898) * 43758.5453
	return x - Math.floor(x)
}

export interface ToolFixtureCell extends ToolMeasures {
	readonly bucket: number
	readonly tool: string
	readonly model: string
	readonly service: string
	readonly env: string
}

/** The week, as flat cells. One pass, so the whole lab shares one dataset. */
export function buildToolCells(nowMs: number): ReadonlyArray<ToolFixtureCell> {
	const cells: ToolFixtureCell[] = []
	const start = nowMs - BUCKETS * BUCKET_MS

	PROFILES.forEach((profile, profileIndex) => {
		for (let index = 0; index < BUCKETS; index++) {
			const bucket = start + index * BUCKET_MS
			// A diurnal swing plus per-bucket noise, so the lines have shape.
			const hourOfDay = ((bucket / HOUR) % 24) / 24
			const diurnal = 0.55 + 0.45 * Math.sin(hourOfDay * Math.PI * 2 - 1.2)
			const noise = 0.7 + wobble(profileIndex * 97 + index) * 0.6
			// `run_tests` regresses through the back half of the window. It is the
			// one thing this page exists to make visible, so the fixture has one.
			const regression =
				profile.name === "run_tests" && index > BUCKETS * 0.6
					? 1 + (index - BUCKETS * 0.6) / 14
					: 1

			profile.models.forEach((model, modelIndex) => {
				const share = 1 / profile.models.length
				const calls = Math.max(0, Math.round(profile.rate * diurnal * noise * share))
				if (calls === 0) return
				// One model is consistently the worse one — the comparison the Models
				// panel exists for.
				const modelPenalty = modelIndex === 0 ? 1 : 1.6
				const errors = Math.round(calls * profile.errorRate * modelPenalty * regression)
				const p50 =
					profile.p50Ms * MS * modelPenalty * regression * (0.85 + wobble(index + modelIndex) * 0.3)
				cells.push({
					bucket,
					tool: profile.name,
					model,
					service: profile.service,
					env: profile.env,
					calls,
					// Roughly a session per handful of calls, floored at one.
					sessions: Math.max(1, Math.round(calls / 6)),
					errors: Math.min(calls, errors),
					p50,
					p90: p50 * (1 + (profile.tail - 1) * 0.35),
					p95: p50 * profile.tail,
				})
			})
		}
	})

	return cells
}

const SESSION_SEEDS = [
	{
		sessionId: "wrun_01M0CSAEW96BH2W9185XZPRPKH",
		agentName: "slack-triage",
		model: "claude-sonnet-5",
		serviceName: "maple-slack-agent",
		tools: ["read_file", "bash", "grep"],
		calls: 61,
		errors: 0,
		avgMs: 14,
		maxMs: 340,
		minutesAgo: 6,
	},
	{
		sessionId: "wrun_01M0CSAEW96BH2W9185XZPRQ44",
		agentName: "deep-research",
		model: "gemini-3-pro",
		serviceName: "research-worker",
		tools: ["web_fetch", "search_source_code"],
		calls: 18,
		errors: 4,
		avgMs: 2_100,
		maxMs: 31_000,
		minutesAgo: 22,
	},
	{
		sessionId: "wrun_01M0CSAEW96BH2W9185XZPRZZ9",
		// No agent name at all: the lane has to hold its width anyway.
		agentName: "",
		model: "claude-opus-5",
		serviceName: "ci-runner",
		tools: ["run_tests", "bash", "deploy_preview_environment_and_wait"],
		calls: 204,
		errors: 51,
		avgMs: 48_000,
		maxMs: 612_000,
		minutesAgo: 58,
	},
	{
		sessionId: "wrun_01M0CSAEW96BH2W9185XZPRAB1",
		agentName: "nightly-reconcile",
		model: "openai/gpt-5.6",
		serviceName: "api",
		tools: ["list_dashboards", "bash"],
		calls: 7,
		errors: 0,
		avgMs: 190,
		maxMs: 420,
		minutesAgo: 190,
	},
	{
		sessionId: "wrun_01M0CSAEW96BH2W9185XZPRCD2",
		agentName: "support-autoresponder-with-a-very-long-name",
		model: "claude-sonnet-5",
		serviceName: "maple-slack-agent",
		tools: ["read_file"],
		calls: 2,
		errors: 0,
		avgMs: 9,
		maxMs: 11,
		minutesAgo: 340,
	},
	{
		sessionId: "wrun_01M0CSAEW96BH2W9185XZPREF3",
		agentName: "planner",
		model: "claude-opus-5",
		serviceName: "ci-runner",
		tools: ["run_tests"],
		calls: 41,
		errors: 19,
		avgMs: 62_000,
		maxMs: 240_000,
		minutesAgo: 700,
	},
] as const

/**
 * Roll cells up by a key, adding the counts and call-weighting the percentiles —
 * the same compromise `foldSeries` documents, and for the same reason: there is
 * no way to combine two p90s into the p90 of their union.
 */
function rollup(
	cells: ReadonlyArray<ToolFixtureCell>,
	keyOf: (cell: ToolFixtureCell) => string,
): Map<string, ToolMeasures> {
	const sums = new Map<string, ToolMeasures>()
	const weights = new Map<string, { p50: number; p90: number; p95: number }>()

	for (const cell of cells) {
		const key = keyOf(cell)
		const previous = sums.get(key) ?? EMPTY_MEASURES
		const weight = weights.get(key) ?? { p50: 0, p90: 0, p95: 0 }
		weights.set(key, {
			p50: weight.p50 + cell.p50 * cell.calls,
			p90: weight.p90 + cell.p90 * cell.calls,
			p95: weight.p95 + cell.p95 * cell.calls,
		})
		sums.set(key, {
			calls: previous.calls + cell.calls,
			sessions: previous.sessions + cell.sessions,
			errors: previous.errors + cell.errors,
			p50: 0,
			p90: 0,
			p95: 0,
		})
	}

	const out = new Map<string, ToolMeasures>()
	for (const [key, value] of sums) {
		const weight = weights.get(key)!
		out.set(key, {
			...value,
			p50: value.calls > 0 ? weight.p50 / value.calls : 0,
			p90: value.calls > 0 ? weight.p90 / value.calls : 0,
			p95: value.calls > 0 ? weight.p95 / value.calls : 0,
		})
	}
	return out
}

/**
 * The page's data under a scope, derived the way the four endpoints would derive
 * it — including the asymmetry that matters: the Tools table ignores the tool
 * selection and the Models panel ignores the model selection, so neither can
 * strand the reader on a table holding only the row they already picked.
 */
export function buildToolAnalyticsFixture(
	search: ToolAnalyticsSearch,
	nowMs: number,
	cells: ReadonlyArray<ToolFixtureCell>,
): AgentToolsViewData {
	const needle = (search.q ?? "").trim().toLowerCase()
	const filtered = cells.filter((cell) => {
		if (needle !== "" && !cell.tool.toLowerCase().includes(needle)) return false
		if (search.service !== undefined && cell.service !== search.service) return false
		if (search.env !== undefined && cell.env !== search.env) return false
		if (search.failing === true && cell.errors === 0) return false
		return true
	})

	const scoped = filtered.filter(
		(cell) =>
			(search.tool === undefined || cell.tool === search.tool) &&
			(search.model === undefined || cell.model === search.model),
	)

	// The chart's split follows the selection, exactly as `aiToolsSeriesKind`
	// derives it server-side: by tool until a tool is picked, by the models that
	// tool ran under until a model is, then a single series still named by the
	// tool.
	const seriesKind: AiToolsSeriesKind =
		search.tool !== undefined && search.model === undefined ? "model" : "tool"
	const seriesKeyOf = (cell: ToolFixtureCell) => (seriesKind === "model" ? cell.model : cell.tool)

	// `\u0000` separates the rollup key's two halves: it is the one character a
	// tool or model name cannot contain.
	const series: ToolSeriesPoint[] = [
		...rollup(scoped, (cell) => `${cell.bucket}\u0000${seriesKeyOf(cell)}`).entries(),
	].map(([key, value]) => {
		const [bucket, seriesKey] = key.split("\u0000")
		return { bucket: Number(bucket), seriesKey: seriesKey!, ...value }
	})

	const totals: ToolTotals = rollup(scoped, () => "all").get("all") ?? EMPTY_MEASURES

	// The comparison window. The fixture holds no earlier data, so it is modelled
	// as "busier and slower than last week, but failing less" — enough to put
	// every delta arrow and both colours on screen at once.
	const previousTotals: ToolTotals = {
		calls: Math.round(totals.calls * 0.88),
		sessions: Math.round(totals.sessions * 0.93),
		errors: Math.round(totals.errors * 1.15),
		p50: totals.p50 * 0.96,
		p90: totals.p90 * 0.74,
		p95: totals.p95 * 0.7,
	}

	const lastSeenBy = (keyOf: (cell: ToolFixtureCell) => string) => {
		const out = new Map<string, number>()
		for (const cell of filtered) {
			const key = keyOf(cell)
			out.set(key, Math.max(out.get(key) ?? 0, cell.bucket))
		}
		return out
	}

	const breakdown = (
		rows: ReadonlyArray<ToolFixtureCell>,
		keyOf: (cell: ToolFixtureCell) => string,
	): ReadonlyArray<ToolBreakdownRow> => {
		const lastSeen = lastSeenBy(keyOf)
		return [...rollup(rows, keyOf).entries()]
			.map(([key, value]) => ({ key, ...value, lastSeen: lastSeen.get(key) ?? nowMs }))
			.sort((a, b) => b.calls - a.calls)
	}

	const sessions: ReadonlyArray<ToolSessionRow> = SESSION_SEEDS.filter(
		(seed) =>
			(search.tool === undefined || (seed.tools as ReadonlyArray<string>).includes(search.tool)) &&
			(search.model === undefined || seed.model === search.model) &&
			(search.service === undefined || seed.serviceName === search.service) &&
			(search.failing !== true || seed.errors > 0),
	).map((seed) => ({
		sessionId: seed.sessionId,
		agentName: seed.agentName,
		model: seed.model,
		serviceName: seed.serviceName,
		calls: seed.calls,
		errors: seed.errors,
		avgDurationNs: seed.avgMs * MS,
		maxDurationNs: seed.maxMs * MS,
		startedAt: nowMs - seed.minutesAgo * 60_000,
	}))

	return {
		series,
		seriesKind,
		totals,
		previousTotals,
		// The denominator: the window under the toolbar filters, before the chips.
		scopeCalls: filtered.reduce((sum, cell) => sum + cell.calls, 0),
		tools: breakdown(
			filtered.filter((cell) => search.model === undefined || cell.model === search.model),
			(cell) => cell.tool,
		),
		models: breakdown(
			filtered.filter((cell) => search.tool === undefined || cell.tool === search.tool),
			(cell) => cell.model,
		),
		sessions,
	}
}

/** The service / env options the toolbar's selects offer, counted like the real facets. */
export function toolFixtureFacets(cells: ReadonlyArray<ToolFixtureCell>) {
	const count = (keyOf: (cell: ToolFixtureCell) => string) => {
		const out = new Map<string, number>()
		for (const cell of cells) {
			const key = keyOf(cell)
			out.set(key, (out.get(key) ?? 0) + cell.sessions)
		}
		return [...out.entries()]
			.map(([name, value]) => ({ name, count: value }))
			.sort((a, b) => b.count - a.count)
	}
	return { services: count((cell) => cell.service), environments: count((cell) => cell.env) }
}
