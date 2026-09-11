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
	type ToolErrorOccurrenceRow,
	type ToolErrorRow,
	type ToolErrorSessionRow,
	type ToolMeasures,
	type ToolSeriesPoint,
	type ToolTotals,
} from "@/lib/agent-sessions/tool-analytics"
import type { ToolAnalyticsSearch } from "@/lib/agent-sessions/tool-search"
import type { AgentToolsViewData } from "@/components/agent-sessions/tools/agent-tools-view"
import type { ToolDetailViewData } from "@/components/agent-sessions/tools/tool-detail-view"
import type { ToolErrorDetailData } from "@/components/agent-sessions/tools/tool-error-modal"
import type { AgentSessionRow } from "@/components/agent-sessions/agent-sessions-list"

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
 * Roll cells up by a key, adding the counts and call-weighting the percentiles.
 * A fixture's shortcut only: two p90s do not combine into the p90 of their
 * union, which is why the real reads merge inside the query.
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

	// The chart's read: the same scope, one series (`split: "none"`).
	const scopeSeries: ToolSeriesPoint[] = [...rollup(scoped, (cell) => `${cell.bucket}`).entries()].map(
		([bucket, value]) => ({ bucket: Number(bucket), seriesKey: "", ...value }),
	)

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

	const lastSeenBy = (
		keyOf: (cell: ToolFixtureCell) => string,
		pick: (a: number, b: number) => number,
	) => {
		const out = new Map<string, number>()
		for (const cell of filtered) {
			const key = keyOf(cell)
			const seen = out.get(key)
			out.set(key, seen === undefined ? cell.bucket : pick(seen, cell.bucket))
		}
		return out
	}

	const breakdown = (
		rows: ReadonlyArray<ToolFixtureCell>,
		keyOf: (cell: ToolFixtureCell) => string,
	): ReadonlyArray<ToolBreakdownRow> => {
		const lastSeen = lastSeenBy(keyOf, Math.max)
		const firstSeen = lastSeenBy(keyOf, Math.min)
		return [...rollup(rows, keyOf).entries()]
			.map(([key, value]) => ({
				key,
				...value,
				lastSeen: lastSeen.get(key) ?? nowMs,
				firstSeen: firstSeen.get(key) ?? nowMs,
			}))
			.sort((a, b) => b.calls - a.calls)
	}

	const tools = breakdown(
		filtered.filter((cell) => search.model === undefined || cell.model === search.model),
		(cell) => cell.tool,
	)

	return {
		series,
		seriesKind,
		scopeSeries,
		totals,
		previousTotals,
		// The denominator, derived as the route derives it: the model-scoped Tools
		// breakdown, before the tool chip.
		scopeCalls: tools.reduce((sum, row) => sum + row.calls, 0),
		tools,
		// The window's whole session population — the real one counts every agent
		// session, including the ones that called no tool at all, so the fixture's
		// is deliberately larger than any tool total.
		allSessions: Math.round(cells.reduce((sum, cell) => sum + cell.sessions, 0) * 1.4),
	}
}

/** The service / model / env options the toolbar's selects offer, counted like
 *  the real facets. */
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
	return {
		services: count((cell) => cell.service),
		models: count((cell) => cell.model),
		environments: count((cell) => cell.env),
	}
}

/* -------------------------------------------------------------------------------------------------
 * The tool detail page, and the error modal it opens
 *
 * Written as failure PROFILES per tool rather than as rows, so the same shapes
 * a reader needs to see are always present: a dominant failure that is most of
 * a tool's errors, a long tail, and a group that named no error type at all —
 * which is the row the real page has to render as `unknown` and cannot route on.
 * -----------------------------------------------------------------------------------------------*/

interface ErrorProfile {
	readonly errorType: string
	readonly message: string
	/** Share of the tool's failures. The list is normalised, not checked. */
	readonly share: number
}

const ERROR_PROFILES = new Map<string, ReadonlyArray<ErrorProfile>>(Object.entries({
	run_tests: [
		{
			errorType: "TimeoutError",
			message: "Test run exceeded 120s: 3 workers still running (integration/warehouse.test.ts)",
			share: 0.41,
		},
		{
			errorType: "AssertionError",
			message: "expected 200 to equal 401 — auth middleware not applied to /internal",
			share: 0.23,
		},
		{ errorType: "ExitCode(1)", message: "vitest: 4 failed | 212 passed (216) — see stderr", share: 0.18 },
		{ errorType: "ENOENT", message: "no such file or directory: apps/web/src/routes/lab", share: 0.11 },
		{
			errorType: "SandboxUnavailable",
			message: "container could not open a network namespace; refusing to run",
			share: 0.05,
		},
		// The row every one of these tables eventually grows: a span that failed
		// and said nothing about why.
		{ errorType: "", message: "", share: 0.02 },
	],
	bash: [
		{ errorType: "ExitCode(127)", message: "command not found: rg", share: 0.62 },
		{ errorType: "TimeoutError", message: "command exceeded 30s", share: 0.28 },
		{ errorType: "", message: "", share: 0.1 },
	],
	default: [
		{ errorType: "UpstreamError", message: "502 from the upstream service", share: 0.7 },
		{ errorType: "", message: "", share: 0.3 },
	],
} satisfies Record<string, ReadonlyArray<ErrorProfile>>))

const errorProfilesFor = (tool: string): ReadonlyArray<ErrorProfile> =>
	ERROR_PROFILES.get(tool) ?? ERROR_PROFILES.get("default")!

const ARGUMENTS_BY_TOOL = new Map(Object.entries({
	run_tests: `{
  "paths": ["integration/warehouse.test.ts"],
  "workers": 4,
  "timeout_ms": 120000,
  "reporter": "json",
  "bail": false
}`,
	bash: `{
  "command": "rg --json 'IsToolCall' packages/",
  "timeout_ms": 30000
}`,
} satisfies Record<string, string>))

const RESULT_BY_TYPE = new Map(Object.entries({
	TimeoutError: `TimeoutError: Test run exceeded 120s: 3 workers still running
  at Runner.waitForWorkers (runner.ts:214)
  at run_tests (tools/run-tests.ts:88)

{
  "passed": 208,
  "failed": 0,
  "pending": 3,
  "duration_ms": 120004,
  "partial": true
}`,
} satisfies Record<string, string>))

/** The error rows of one tool under the current scope. */
export function buildToolErrorsFixture(
	tool: string,
	failures: number,
	nowMs: number,
): ReadonlyArray<ToolErrorRow> {
	if (failures === 0) return []
	return errorProfilesFor(tool)
		.map((profile, index) => ({
			errorType: profile.errorType,
			message: profile.message,
			calls: Math.max(1, Math.round(failures * profile.share)),
			sessions: Math.max(1, Math.round(failures * profile.share * 0.35)),
			firstSeen: nowMs - (20 + index * 6) * 3_600_000,
			lastSeen: nowMs - (2 + index * 37) * 60_000,
		}))
		.sort((a, b) => b.calls - a.calls)
}

/** The sessions list the detail page shows, in the list read's own row shape —
 *  narrowed like the metrics: a seed survives only where the scoped cells hold
 *  its service (which carries the env), and under the selected model. */
function detailSessions(
	tool: string,
	nowMs: number,
	scoped: ReadonlyArray<ToolFixtureCell>,
	model: string | undefined,
): ReadonlyArray<AgentSessionRow> {
	return SESSION_SEEDS.filter(
		(seed) =>
			(seed.tools as ReadonlyArray<string>).includes(tool) &&
			scoped.some((cell) => cell.service === seed.serviceName) &&
			(model === undefined || seed.model === model),
	).map(
		(seed, index) => {
			const startedAt = nowMs - seed.minutesAgo * 60_000
			const durationMs = seed.maxMs * 4 + 12_000
			return {
				sessionId: seed.sessionId,
				vendorId: ["eve", "claude_agent_sdk", "vercel_ai_sdk", "langchain"][index % 4]!,
				vendorVersion: ["v1.4.2", "v0.9.1", "v5.0.4", "v0.3.27"][index % 4]!,
				traceCount: 1 + (index % 6),
				spanCount: 22 + index * 97,
				errorSpanCount: seed.errors,
				toolErrorCount: seed.errors,
				turnErrorCount: 0,
				serviceNames: [seed.serviceName],
				models: [seed.model],
				agentNames: seed.agentName === "" ? [] : [seed.agentName],
				firstAgentName: seed.agentName,
				llmCalls: Math.round(seed.calls / 3),
				toolCalls: seed.calls,
				totalTokens: seed.calls * 900,
				inputTokens: seed.calls * 600,
				cacheReadTokens: seed.calls * 200,
				cacheWriteTokens: 0,
				outputTokens: seed.calls * 100,
				reasoningTokens: 0,
				cost: seed.calls * 0.004,
				startTime: new Date(startedAt).toISOString().replace("T", " ").slice(0, 23),
				endTime: new Date(startedAt + durationMs).toISOString().replace("T", " ").slice(0, 23),
				durationMs,
			}
		},
	)
}

/** `/agent-sessions/tools/$toolName` over the same week the overview draws. */
export function buildToolDetailFixture(
	tool: string,
	search: ToolAnalyticsSearch,
	nowMs: number,
	cells: ReadonlyArray<ToolFixtureCell>,
): ToolDetailViewData {
	const scoped = cells.filter(
		(cell) =>
			cell.tool === tool &&
			(search.model === undefined || cell.model === search.model) &&
			(search.service === undefined || cell.service === search.service) &&
			(search.env === undefined || cell.env === search.env),
	)
	const series: ToolSeriesPoint[] = [
		...rollup(scoped, (cell) => `${cell.bucket}`).entries(),
	].map(([bucket, value]) => ({ bucket: Number(bucket), seriesKey: tool, ...value }))
	const totals: ToolTotals = rollup(scoped, () => "all").get("all") ?? EMPTY_MEASURES
	const sessions = detailSessions(tool, nowMs, scoped, search.model)

	return {
		series,
		totals,
		scopeCalls: cells
			.filter((cell) => cell.tool === tool)
			.reduce((sum, cell) => sum + cell.calls, 0),
		firstSeen: scoped.reduce((min, cell) => (min === 0 ? cell.bucket : Math.min(min, cell.bucket)), 0),
		lastSeen: scoped.reduce((max, cell) => Math.max(max, cell.bucket), 0),
		errors: buildToolErrorsFixture(tool, totals.errors, nowMs),
		errorsLoading: false,
		errorsFailure: undefined,
		sessions,
		sessionsCapped: false,
		sessionsLoading: false,
		sessionsFailure: undefined,
	}
}

/** One error type of one tool: its sessions, and the calls themselves. */
export function buildToolErrorDetailFixture(
	tool: string,
	errorType: string,
	rows: ReadonlyArray<ToolErrorRow>,
	nowMs: number,
): ToolErrorDetailData {
	const row = rows.find((candidate) => candidate.errorType === errorType)
	const hits = row?.calls ?? 0
	const seeds = SESSION_SEEDS.filter((seed) => (seed.tools as ReadonlyArray<string>).includes(tool))

	const sessions: ReadonlyArray<ToolErrorSessionRow> = seeds.map((seed, index) => ({
		sessionId: seed.sessionId,
		agentName: seed.agentName,
		model: seed.model,
		hits: Math.max(1, Math.round(hits / (index + 2))),
		lastSeen: nowMs - (2 + index * 41) * 60_000,
	}))

	const occurrences: ReadonlyArray<ToolErrorOccurrenceRow> = Array.from({ length: 6 }).map(
		(_, index) => {
			const seed = seeds[index % Math.max(seeds.length, 1)]
			const args = ARGUMENTS_BY_TOOL.get(tool) ?? '{\n  "input": "…"\n}'
			const result =
				RESULT_BY_TYPE.get(errorType) ??
				`${errorType === "" ? "error" : errorType}: ${row?.message ?? ""}`
			return {
				timestamp: nowMs - (3 + index * 14) * 60_000,
				traceId: `7f3a4b5c6d7e8f9012345678${index.toString().padStart(8, "0")}`,
				spanId: `a1b2c3d4e5f6${index.toString().padStart(4, "0")}`,
				sessionId: seed?.sessionId ?? "trace:7f3a4b5c",
				agentName: seed?.agentName ?? "",
				model: seed?.model ?? "",
				errorType,
				message: row?.message ?? "",
				durationNs: 120_000 * MS,
				statusCode: "Error",
				arguments: args,
				argumentsBytes: args.length,
				result,
				resultBytes: result.length,
			}
		},
	)

	return { sessions, occurrences }
}
