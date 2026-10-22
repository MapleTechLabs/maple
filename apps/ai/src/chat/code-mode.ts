/**
 * `run_code`: one tool whose input is a JavaScript program that calls the turn's read-only Maple
 * tools as `maple.<tool>(input)`. A model batches reads and keeps only what it needs, instead of
 * paying a full model round trip, and a re-sent prompt, per call.
 *
 * The program runs in the `CodeExecutor` the caller provides: a Dynamic Worker with no network in
 * production, the in-process substitute in tests. Its only authority is calling these tools back
 * through the engine, so tenancy, rulesets, spans and review coverage are the tools' own.
 */
import { CodeExecutionLimits, type CodeExecutor } from "@yielded/agent/code-executor"
import * as CodeMode from "@yielded/agent/code-mode"
import { Duration, Layer } from "effect"
import { type Tool, Toolkit } from "effect/ai"
import { TOOL_CONCURRENCY } from "./budgets"
import { PR_REVIEW_TOOLS } from "./permissions"

export const RUN_CODE = "run_code"

/**
 * The reads a program may make: every read tool an investigation or a review called in the week to
 * 2026-10-22, plus the review's own. Curated rather than "every allowed tool" because the executor
 * takes at most 64 methods per namespace, and the read-only catalogue is larger.
 */
export const CODE_MODE_TOOLS: ReadonlySet<string> = new Set([
	...PR_REVIEW_TOOLS,
	"ci_runs",
	"compare_commits",
	"compare_periods",
	"describe_warehouse_tables",
	"diagnose_service",
	"find_slow_traces",
	"get_agent_session_transcript",
	"get_alert_rule",
	"get_incident_timeline",
	"get_session_transcript",
	"ingest_freshness",
	"inspect_infra",
	"inspect_span",
	"inspect_trace",
	"list_agent_sessions",
	"list_alert_checks",
	"list_alert_incidents",
	"list_alert_rules",
	"list_error_issue_events",
	"list_error_issues",
	"list_infra",
	"list_integrations",
	"mine_log_patterns",
	"query_data",
	"run_sql",
	"search_logs",
	"search_sessions",
])

/** What a program may hand back to the conversation; a tool's own answer is capped at 50 KiB. */
const MAX_EGRESS_BYTES = 128 * 1024

const LIMITS = CodeExecutionLimits.make({
	maxSourceBytes: 64 * 1024,
	// 32 calls, 4 at a time (a direct batch's fan-out), finish inside this even at the 5-10 s a
	// warehouse query can take.
	maxWallTime: Duration.seconds(120),
	maxHostCalls: 32,
	maxHostCallConcurrency: TOOL_CONCURRENCY,
	// No `cpuMillis`: the Dynamic Worker's platform CPU limit stops a runaway loop, and the test
	// executor refuses a limit it cannot enforce.
	maxLogBytes: 64 * 1024,
	maxResultBytes: MAX_EGRESS_BYTES,
	maxHostCallArgumentBytes: 64 * 1024,
	maxHostCallResultBytes: 1024 * 1024,
})

const description = (methods: ReadonlyArray<string>) =>
	[
		"Run a JavaScript program that calls Maple tools, for several independent reads at once or for reading a lot and keeping a little.",
		"`maple.<tool>(input)` takes the same input as the tool of that name and resolves to its text result; a failed call rejects.",
		"Return only what you need (matching lines, a summary, counts): the whole result is added to the conversation.",
		'Example: async () => { const diffs = await Promise.all(paths.map((path) => maple.pr_file_diff({ repository, number, path }))); return diffs.map((diff) => diff.split("\\n").filter((line) => line.includes("catch"))) }',
		`Up to ${LIMITS.maxHostCalls} calls, ${Duration.toSeconds(LIMITS.maxWallTime)} s and ${MAX_EGRESS_BYTES / 1024} KiB of result per program; past that the program fails and returns nothing.`,
		`Methods: ${methods.map((method) => `maple.${method}`).join(", ")}.`,
	].join("\n")

/**
 * `run_code` over `tools`, or undefined when there is nothing to call. `handlers` provides those
 * tools' handlers; the program's calls run through them.
 */
export const buildCodeMode = <T extends Tool.Any, H, E, R>(
	tools: Readonly<Record<string, T>>,
	handlers: Layer.Layer<H, E, R>,
	executor: Layer.Layer<CodeExecutor>,
) => {
	const methods = Object.keys(tools).sort()
	if (methods.length === 0) return undefined
	const definition = CodeMode.make(RUN_CODE, {
		description: description(methods),
		// The direct tools are offered alongside, so the model has every schema already.
		includeDeclarations: false,
		tools: { maple: tools },
		limits: LIMITS,
		maxEgressBytes: MAX_EGRESS_BYTES,
	})
	return {
		tool: RUN_CODE,
		toolkit: Toolkit.make(definition.tool),
		layer: definition.handlers.pipe(Layer.provide(handlers), Layer.provide(executor)),
	}
}
