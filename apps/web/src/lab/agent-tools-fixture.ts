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
	// The three tools the detail view opens on, at the volumes their failures
	// were recorded against — see the error groups further down.
	{
		name: "submit_candidate",
		service: "maple-investigations",
		env: "production",
		rate: 18,
		errorRate: 0.55,
		p50Ms: 1,
		tail: 3,
		models: ["z-ai/glm-5.3-flash:nitro"],
	},
	{
		name: "query_data",
		service: "maple-investigations",
		env: "production",
		rate: 32,
		errorRate: 0.03,
		p50Ms: 640,
		tail: 8,
		models: ["z-ai/glm-5.3-flash:nitro"],
	},
	{
		name: "sandbox_exec",
		service: "maple-chat",
		env: "production",
		rate: 2,
		errorRate: 0.1,
		p50Ms: 8_400,
		tail: 4,
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
 * The tool detail page, and the error group modal it opens
 *
 * Written from real tool failures rather than invented ones, so the page is
 * reviewed against the shapes it will actually meet: a schema decoder's message
 * inside a `{"result": …}` envelope, a dominant group that is most of a tool's
 * failures, groups that fold several array indices into one, a long tail of
 * one-offs, a failure recorded before grouping existed, and a tool that
 * reports nothing about why it failed. Counts are verbatim; which day they
 * fell on is shaped to show one group that stopped and one that has not.
 * -----------------------------------------------------------------------------------------------*/

const DAY = 86_400_000

interface ErrorGroupSpec {
	/** The group's raw text, as the index keeps it. */
	readonly message: string
	readonly errorType: string
	readonly calls: number
	readonly sessions: number
	/** The raw texts the group folded, where there is more than one. */
	readonly variants?: ReadonlyArray<{ readonly message: string; readonly calls: number }>
	/** Failed calls per day of the week, oldest first. */
	readonly perDay: ReadonlyArray<number>
	/** Calls of the tool since the group's latest failure. */
	readonly callsSince: number
	/** What a failed call was made with. `''` where the span recorded none. */
	readonly arguments: (index: number) => string
	/** Where the failures happen, as `[model, service, share]`. */
	readonly where?: ReadonlyArray<readonly [string, string, number]>
}

/** A tool result's error envelope, as the maple vendor records one. */
const envelope = (text: string) => JSON.stringify({ result: text })

const FINDINGS_CLAIM =
	"Confirmed: the incident's failure is a disk-capacity exhaustion — the embedded chDB store on the local filesystem hit its \"no space left on device\" ceiling, and at least one trace ingest (POST /v1/traces) was rejected with HTTP 500 as a result."
const LOG_PATTERN =
	"chDB insert (traces): Code: 1001. DB::Exception: filesystem error: in create_directories: No space left on device [\"/var/lib/maple/store/traces\"]"

const evidenceItem = (index: number, omit?: "traceIds" | "logPatterns") => ({
	...(omit !== "logPatterns" && { logPatterns: [LOG_PATTERN] }),
	note: `Single error occurrence at 01:5${index}, one ingest request rejected while the store was full.`,
	...(omit !== "traceIds" && { traceIds: [`4bf92f3577b34da6a3ce929d0e0e47${30 + index}`] }),
})

const candidate = (overrides: Record<string, unknown>) =>
	JSON.stringify({
		claim: FINDINGS_CLAIM,
		confidence: "high",
		mechanism: "The store's volume filled; every insert after that failed until the volume was grown.",
		evidence: [evidenceItem(0), evidenceItem(1)],
		suggestedActions: ["Grow the store's volume", "Alert on free space below 10%"],
		...overrides,
	})

const queryData = (overrides: Record<string, unknown>) =>
	JSON.stringify({
		source: "traces",
		kind: "breakdown",
		start_time: "2026-09-04 00:00:00",
		end_time: "2026-09-11 00:00:00",
		...overrides,
	})

const INVESTIGATIONS: ReadonlyArray<readonly [string, string, number]> = [
	["z-ai/glm-5.3-flash:nitro", "maple-investigations", 0.912],
	["z-ai/glm-5.3-flash:nitro", "maple-api", 0.067],
	["z-ai/glm-5.3-flash", "maple-investigations", 0.021],
]

const missingKeyAt = (path: string) => envelope(`Invalid tool input: Missing key\n  at ${path}`)
const expectedAt = (expected: string, path: string) =>
	envelope(`Invalid tool input: Expected ${expected}\n  at ${path}`)

const ERROR_GROUPS = new Map<string, ReadonlyArray<ErrorGroupSpec>>([
	[
		"submit_candidate",
		[
			{
				message: expectedAt("array", '["evidence"]'),
				errorType: "tool_error",
				calls: 387,
				sessions: 175,
				perDay: [60, 110, 58, 159, 0, 0, 0, 0],
				callsSince: 281,
				// The model sent the array as a string holding its JSON.
				arguments: (index) =>
					candidate({ evidence: JSON.stringify([evidenceItem(index), evidenceItem(index + 1)]) }),
				where: INVESTIGATIONS,
			},
			{
				message: missingKeyAt('["claim"]'),
				errorType: "tool_error",
				calls: 116,
				sessions: 63,
				perDay: [40, 45, 30, 1, 0, 0, 0, 0],
				callsSince: 290,
				arguments: () => "{}",
				where: INVESTIGATIONS,
			},
			{
				message: missingKeyAt('["evidence"][0]["logPatterns"]'),
				errorType: "tool_error",
				calls: 18,
				sessions: 18,
				variants: [
					{ message: missingKeyAt('["evidence"][0]["logPatterns"]'), calls: 12 },
					{ message: missingKeyAt('["evidence"][1]["logPatterns"]'), calls: 6 },
				],
				perDay: [5, 8, 5, 0, 0, 0, 0, 0],
				callsSince: 402,
				arguments: (index) =>
					candidate({
						evidence: index % 3 === 2 ? [evidenceItem(0), evidenceItem(1, "logPatterns")] : [evidenceItem(0, "logPatterns"), evidenceItem(1)],
					}),
			},
			{
				message: missingKeyAt('["evidence"][0]["traceIds"]'),
				errorType: "tool_error",
				calls: 9,
				sessions: 9,
				variants: [
					{ message: missingKeyAt('["evidence"][0]["traceIds"]'), calls: 4 },
					{ message: missingKeyAt('["evidence"][1]["traceIds"]'), calls: 3 },
					{ message: missingKeyAt('["evidence"][2]["traceIds"]'), calls: 2 },
				],
				perDay: [3, 4, 1, 1, 0, 0, 0, 0],
				callsSince: 284,
				arguments: (index) =>
					candidate({
						evidence: [0, 1, 2].map((item) => evidenceItem(item, item === variantIndex(index, [4, 3, 2]) ? "traceIds" : undefined)),
					}),
			},
			{
				message: missingKeyAt('["mechanism"]'),
				errorType: "tool_error",
				calls: 6,
				sessions: 6,
				perDay: [1, 2, 2, 1, 0, 0, 0, 0],
				callsSince: 300,
				arguments: () => JSON.stringify({ claim: FINDINGS_CLAIM, confidence: "medium", evidence: [evidenceItem(0)] }),
			},
			{
				message: expectedAt("array", '["suggestedActions"]'),
				errorType: "tool_error",
				calls: 6,
				sessions: 5,
				perDay: [2, 1, 2, 1, 0, 0, 0, 0],
				callsSince: 296,
				arguments: () => candidate({ suggestedActions: JSON.stringify(["Grow the store's volume"]) }),
			},
			{
				message: expectedAt("object", '["evidence"][0]'),
				errorType: "tool_error",
				calls: 3,
				sessions: 3,
				perDay: [1, 0, 1, 1, 0, 0, 0, 0],
				callsSince: 330,
				// A string the schema cannot read as an object: no hint claims otherwise.
				arguments: () => candidate({ evidence: ["disk full on the store volume"] }),
			},
		],
	],
	[
		"query_data",
		[
			{
				message:
					"Tool failed: `group_by=attribute` requires `attribute_key`. Use explore_attributes to discover available keys.",
				errorType: "tool_error",
				calls: 14,
				sessions: 13,
				perDay: [1, 2, 1, 3, 2, 1, 3, 1],
				callsSince: 40,
				arguments: () => queryData({ group_by: "attribute" }),
			},
			{
				message:
					'Tool failed: Invalid group_by "service.version" for source="traces" kind="breakdown". Valid group_by values: "service", "span_name", "status_code", "http_method", "attribute".',
				errorType: "tool_error",
				calls: 7,
				sessions: 6,
				perDay: [0, 2, 1, 2, 0, 1, 1, 0],
				callsSince: 210,
				arguments: () => queryData({ group_by: "service.version" }),
			},
			{
				message:
					'Tool failed: Invalid parameters: SchemaError(Missing key at ["source"]). Check the "query_data" tool schema for valid parameter names and types.',
				errorType: "tool_error",
				calls: 5,
				sessions: 5,
				perDay: [1, 1, 0, 2, 0, 1, 0, 0],
				callsSince: 260,
				arguments: () => JSON.stringify({ kind: "timeseries", group_by: "service" }),
			},
			{
				message:
					'Tool failed: Invalid parameters: SchemaError(Missing key at ["kind"]). Check the "query_data" tool schema for valid parameter names and types.',
				errorType: "tool_error",
				calls: 5,
				sessions: 3,
				perDay: [0, 0, 3, 0, 1, 0, 1, 0],
				callsSince: 120,
				arguments: () => JSON.stringify({ source: "logs", group_by: "service" }),
			},
			{
				message:
					'Tool failed: Invalid group_by "service.version" for source="traces" kind="timeseries". Valid group_by values: "service", "span_name", "none".',
				errorType: "tool_error",
				calls: 3,
				sessions: 2,
				perDay: [0, 1, 2, 0, 0, 0, 0, 0],
				callsSince: 900,
				arguments: () => queryData({ kind: "timeseries", group_by: "service.version" }),
			},
			{
				message:
					"Tool failed: `source=metrics` requires `metric_name` and `metric_type`. Use list_metrics to discover available metrics.",
				errorType: "tool_error",
				calls: 3,
				sessions: 1,
				perDay: [0, 0, 0, 0, 0, 3, 0, 0],
				callsSince: 510,
				arguments: () => queryData({ source: "metrics" }),
			},
			{
				message:
					'Tool failed: Invalid group_by "commit_shas" for source="traces" kind="breakdown". Valid group_by values: "service", "span_name", "status_code", "http_method", "attribute".',
				errorType: "tool_error",
				calls: 3,
				sessions: 3,
				perDay: [1, 0, 1, 0, 0, 1, 0, 0],
				callsSince: 520,
				arguments: () => queryData({ group_by: "commit_shas" }),
			},
			{
				message:
					"Tool failed: @maple/http/errors/QueryEngineValidationError: Timeseries query too expensive\nRequested 2154 points, maximum is 1500",
				errorType: "tool_error",
				calls: 2,
				sessions: 2,
				variants: [
					{
						message:
							"Tool failed: @maple/http/errors/QueryEngineValidationError: Timeseries query too expensive\nRequested 2154 points, maximum is 1500",
						calls: 1,
					},
					{
						message:
							"Tool failed: @maple/http/errors/QueryEngineValidationError: Timeseries query too expensive\nRequested 1790 points, maximum is 1500",
						calls: 1,
					},
				],
				perDay: [0, 0, 1, 0, 0, 0, 1, 0],
				callsSince: 150,
				arguments: () => queryData({ kind: "timeseries", bucket_seconds: 280 }),
			},
			{
				message:
					'Tool failed: Invalid parameters: SchemaError(`2026-09-04 00:00` is not a timestamp — expected `YYYY-MM-DD HH:mm:ss` (UTC) or an ISO-8601 timestamp at ["start_time"]). Check the "query_data" tool schema for valid parameter names and types.',
				errorType: "tool_error",
				calls: 1,
				sessions: 1,
				perDay: [0, 0, 1, 0, 0, 0, 0, 0],
				callsSince: 1_200,
				arguments: () => queryData({ start_time: "2026-09-04 00:00" }),
			},
			{
				message:
					'Tool failed: Invalid group_by "vcs.ref.head.revision" for source="traces" kind="breakdown". Valid group_by values: "service", "span_name", "status_code", "http_method", "attribute".',
				errorType: "tool_error",
				calls: 1,
				sessions: 1,
				perDay: [0, 0, 0, 0, 1, 0, 0, 0],
				callsSince: 700,
				arguments: () => queryData({ group_by: "vcs.ref.head.revision" }),
			},
			...[
				"Tool failed: Timeout exceeded: elapsed 15346.717367 ms, maximum: 15000 ms (query_id=01M1XS1YN5140J9SMWJTC5GGMJ)",
				"Tool failed: Unknown metric `http.server.request.duration`. Use list_metrics to discover available metrics.",
				'Tool failed: Invalid filter "status_code=5xx". Filters compare one attribute to one value.',
				"Tool failed: Requested 171.3 hours, maximum is 168 hours",
				"Tool failed: `kind=breakdown` does not accept `bucket_seconds`.",
				"Tool failed: Repository 'maple/maple-api' is not connected to this organization",
			].map(
				(message, index): ErrorGroupSpec => ({
					message,
					errorType: "tool_error",
					calls: 1,
					sessions: 1,
					perDay: [0, 1, 2, 3, 4, 5, 6, 7].map((day) => (day === index + 1 ? 1 : 0)),
					callsSince: 300 + index * 80,
					arguments: () => queryData({}),
				}),
			),
			// Recorded before failures kept their text: one group, named for what it is.
			{
				message: "",
				errorType: "",
				calls: 1,
				sessions: 1,
				perDay: [1, 0, 0, 0, 0, 0, 0, 0],
				callsSince: 1_700,
				arguments: () => "",
			},
		],
	],
	[
		"sandbox_exec",
		[
			{
				// The framework reports a generic message and records neither the
				// arguments nor the result: the cause is not in the telemetry.
				message: "effect-agent.execute_tool: Tool execution reached a failed terminal state",
				errorType: "ToolCallFailed",
				calls: 4,
				sessions: 3,
				perDay: [0, 2, 0, 1, 0, 1, 0, 0],
				callsSince: 0,
				arguments: () => "",
				where: [["", "maple-chat", 1]],
			},
		],
	],
])

/** The tools the lab's detail view can open, and the shape each one shows. */
export const DETAIL_TOOLS = ["submit_candidate", "query_data", "sandbox_exec", "grep"] as const

/** Which of a group's variants the `index`-th sample is, spread by their counts. */
function variantIndex(index: number, counts: ReadonlyArray<number>): number {
	const total = counts.reduce((sum, count) => sum + count, 0)
	let slot = index % total
	for (const [position, count] of counts.entries()) {
		if (slot < count) return position
		slot -= count
	}
	return 0
}

/** A stable fake fingerprint per group — any decimal UInt64 will do. */
const fingerprintOf = (message: string, index: number) =>
	message === ""
		? "0"
		: String(
				[...message].reduce((hash, char) => (hash * 31n + BigInt(char.charCodeAt(0))) % 18_446_744_073_709_551_557n, BigInt(index + 7)),
			)

const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY

/** The error groups of one tool, as the Errors read returns them. */
export function buildToolErrorsFixture(tool: string, nowMs: number): ReadonlyArray<ToolErrorRow> {
	const today = dayStart(nowMs)
	return (ERROR_GROUPS.get(tool) ?? []).map((spec, index) => {
		const days = spec.perDay.map((calls, day) => ({ bucket: today - (spec.perDay.length - 1 - day) * DAY, calls }))
		const active = days.filter((day) => day.calls > 0)
		const lastDay = active[active.length - 1]?.bucket ?? today
		return {
			fingerprint: fingerprintOf(spec.message, index),
			errorType: spec.errorType,
			message: spec.message,
			calls: spec.calls,
			sessions: spec.sessions,
			variants: spec.variants?.length ?? 1,
			firstSeen: (active[0]?.bucket ?? today) + 9 * 3_600_000 + index * 60_000,
			// The newest day at 23:48, or the morning for a group still failing today.
			lastSeen: Math.min(lastDay + 23 * 3_600_000 + 48 * 60_000 - index * 67_000, nowMs - 22 * 3_600_000 - index * 60_000),
			callsSince: spec.callsSince,
			trend: days.filter((day) => day.calls > 0),
		}
	})
}

const SAMPLE_SESSION_IDS = [
	"7a3e91c4-5b02-4d8f-9c11-2f6b0e4a7d19",
	"2f8b06d7-91ce-4a35-8b70-5d2c6e9f0a41",
	"c41e5a90-0d7b-4f62-a3e8-91b7d24c6f05",
	"e03b7d21-6a4f-4c9e-b812-7f05a3d9c2e6",
	"9e2144b4-626f-4633-8ca5-ac2771f9d6e3",
	"41c7d0a9-3be2-4f18-9d6a-5e08b7c21f94",
]

/** One group's facts and a page of its samples, as the detail and samples reads
 *  return them. `pages` stands in for the reader's "Load 25 more" clicks. */
export function buildToolErrorDetailFixture(
	tool: string,
	row: ToolErrorRow,
	nowMs: number,
	options: { readonly session?: string; readonly variant?: string; readonly pages: number },
): { readonly detail: ToolErrorDetailData; readonly occurrences: ReadonlyArray<ToolErrorOccurrenceRow>; readonly hasMore: boolean } {
	const spec = (ERROR_GROUPS.get(tool) ?? []).find((candidate, index) => fingerprintOf(candidate.message, index) === row.fingerprint)
	if (spec === undefined) return { detail: { sessions: [], variants: [], breakdown: [] }, occurrences: [], hasMore: false }
	const variants = spec.variants ?? [{ message: spec.message, calls: spec.calls }]
	const where = spec.where ?? [["z-ai/glm-5.3-flash:nitro", "maple-investigations", 1] as const]
	const sessionIds = SAMPLE_SESSION_IDS.slice(0, Math.min(SAMPLE_SESSION_IDS.length, spec.sessions))

	const sessions: ReadonlyArray<ToolErrorSessionRow> = sessionIds.map((sessionId, index) => ({
		sessionId,
		vendorId: "maple",
		agentName: "investigation-lane",
		service: where[index % where.length]![1],
		hits: Math.max(1, Math.round(spec.calls / (spec.sessions + index))),
		lastSeen: row.lastSeen - index * 47 * 60_000,
	}))

	const all: ReadonlyArray<ToolErrorOccurrenceRow> = Array.from({ length: spec.calls }, (_, index) => {
		const variant = variants[variantIndex(index, variants.map((candidate) => candidate.calls))]!
		const [model, service] = where[index % where.length]!
		const args = spec.arguments(index)
		const result = spec.message.startsWith("{") ? variant.message : ""
		return {
			timestamp: row.lastSeen - index * 37 * 60_000,
			traceId: `4bf92f3577b34da6a3ce929d${index.toString(16).padStart(8, "0")}`,
			spanId: `a1b2c3d4${index.toString(16).padStart(8, "0")}`,
			sessionId: sessionIds[index % sessionIds.length] ?? "trace:4bf92f3577b34da6a3ce929d0e0e4736",
			vendorId: "maple",
			agentName: "investigation-lane",
			model,
			service,
			errorType: spec.errorType,
			message: variant.message,
			durationNs: (index % 3) * MS,
			statusCode: result === "" ? "Error" : "Ok",
			arguments: args,
			argumentsBytes: new TextEncoder().encode(args).length,
			result,
			resultBytes: new TextEncoder().encode(result).length,
		}
	})
	const narrowed = all.filter(
		(occurrence) =>
			(options.session === undefined || occurrence.sessionId === options.session) &&
			(options.variant === undefined || occurrence.message === options.variant),
	)
	return {
		detail: {
			sessions,
			variants: spec.variants === undefined ? [{ message: spec.message, calls: spec.calls, lastSeen: row.lastSeen }] : variants.map((candidate, index) => ({ ...candidate, lastSeen: row.lastSeen - index * 3_600_000 })),
			breakdown: where.map(([model, service, share]) => ({ model, service, calls: Math.max(1, Math.round(spec.calls * share)) })),
		},
		occurrences: narrowed.slice(0, 25 * options.pages),
		hasMore: narrowed.length > 25 * options.pages,
	}
}

/** The sessions list the detail page shows, in the list read's own row shape —
 *  narrowed like the metrics: a seed survives only where the scoped cells hold
 *  its service (which carries the env), and under the selected model. The tools
 *  the lab borrows from production have no seeds of their own, so they take
 *  every seed that ran under their scope. */
function detailSessions(
	tool: string,
	nowMs: number,
	scoped: ReadonlyArray<ToolFixtureCell>,
	model: string | undefined,
): ReadonlyArray<AgentSessionRow> {
	const seeded = SESSION_SEEDS.some((seed) => (seed.tools as ReadonlyArray<string>).includes(tool))
	return SESSION_SEEDS.filter(
		(seed) =>
			(!seeded ||
				((seed.tools as ReadonlyArray<string>).includes(tool) &&
					scoped.some((cell) => cell.service === seed.serviceName))) &&
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
		description: `Runs ${tool} in the agent's workspace and returns its output, truncated to the last 4,000 characters.`,
		range: { startMs: nowMs - BUCKETS * BUCKET_MS, endMs: nowMs },
		errors: buildToolErrorsFixture(tool, nowMs),
		errorsLoading: false,
		errorsFailure: undefined,
		sessions,
		sessionsCapped: false,
		sessionsLoading: false,
		sessionsFailure: undefined,
	}
}
