import { DateTime, Effect, Schema } from "effect"
import { CiRunsOutput } from "@maple/domain/mcp-outputs"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import { isMissingCiTables } from "@maple/backend/services/warehouse/missing-table"
import { McpUnavailableError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"

const TOOL = "ci_runs"
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: MCP_DISCOVERY_MAX_HOURS })
const RESULTS = ["success", "failure", "timeout", "cancellation", "skip", "error"] as const
/** Failed jobs read per failed run: a matrix workflow can fail dozens of jobs at once. */
const FAILED_JOBS_PER_RUN = 50
/** Runs read for the per-workflow summary; the listed runs are the newest `limit` of these. */
const SUMMARY_CAP = 500

type Output = typeof CiRunsOutput.Type

/** CI runs take minutes: "13m 40s", "48s". */
const formatRunDuration = (ms: number) => {
	const seconds = Math.round(ms / 1000)
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const quantile = (sorted: ReadonlyArray<number>, q: number) =>
	sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0)

interface SummarizedRun {
	readonly repository: string
	readonly pipeline: string
	readonly result: string
	readonly revision: string
	readonly durationMs: number
	readonly startedAt: DateTime.Utc
}

const summarize = (runs: ReadonlyArray<SummarizedRun>): Output["pipelines"] => {
	const groups = new Map<string, Array<SummarizedRun>>()
	for (const run of runs) {
		const key = `${run.repository}\u0000${run.pipeline}`
		groups.set(key, [...(groups.get(key) ?? []), run])
	}
	return [...groups.values()]
		.flatMap((group) => {
			// Rows arrive newest first, so the head of each group is its latest run.
			const latest = group[0]
			if (latest === undefined) return []
			const durations = group.map((run) => run.durationMs).sort((a, b) => a - b)
			const streak = CH.ciRedStreak(group)
			const red =
				streak === undefined
					? undefined
					: {
							failedRuns: streak.failedRuns,
							since: DateTime.formatIso(streak.firstFailed.startedAt),
							firstFailedRevision: streak.firstFailed.revision,
							...(streak.lastGreen === undefined
								? undefined
								: {
										lastGreenRevision: streak.lastGreen.revision,
										lastGreenAt: DateTime.formatIso(streak.lastGreen.startedAt),
									}),
						}
			return [
				{
					pipeline: latest.pipeline,
					repository: latest.repository,
					runs: group.length,
					failed: group.filter((run) => CH.isCiFailedResult(run.result)).length,
					p50DurationMs: quantile(durations, 0.5),
					p95DurationMs: quantile(durations, 0.95),
					lastResult: latest.result,
					lastStartedAt: DateTime.formatIso(latest.startedAt),
					...(red === undefined ? undefined : { red }),
				},
			]
		})
		.sort((a, b) => b.failed - a.failed || b.runs - a.runs)
}

export function registerCiRunsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "CI Runs",
		description:
			"GitHub Actions workflow runs from the GitHub integration's CI traces: per workflow, how many runs failed and the p50/p95 duration; per run, its result, branch, commit, duration and, for a failed run, which jobs failed and why (the failure annotation). Answers 'why is CI red', 'which workflow is flaky', 'did CI pass on this commit' and 'are builds getting slower'. Each run is a trace: inspect_trace on its trace id shows the job and step waterfall with runner queue time.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			pipeline: P.optionalText("Only this workflow (exact name, e.g. `CI`)"),
			repository: P.optionalText("Only this repository, by name without the owner (e.g. `api`)"),
			branch: P.optionalText("Only runs on this head branch"),
			result: P.optionalOneOf(RESULTS, "Only runs with this result"),
			limit: P.limit({ default: 20, max: 100, noun: "runs to list" }),
		}),
		output: CiRunsOutput,
		hints: { readOnly: true },
		phrases: ["Checking CI runs", "Reading workflow runs"],
		handler: Effect.fn("McpTool.ciRuns")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })

			// The result filter narrows the listed runs only: the red analysis needs the passing runs
			// around a failure streak to name its last green commit.
			const { runs, matched, listed, failedJobs, failedJobsCap } = yield* withTenantExecutor(
				Effect.gen(function* () {
					const executor = yield* WarehouseExecutor
					const window = { orgId: executor.orgId, startTime: st, endTime: et }
					const runs = yield* executor.compiledQuery(
						CH.compile(
							CH.ciRunsQuery({
								pipeline: params.pipeline,
								repository: params.repository,
								branch: params.branch,
								limit: SUMMARY_CAP,
							}),
							window,
						),
						{ profile: "list", context: "ciRuns" },
					)
					const matched = runs.filter(
						(run) => params.result === undefined || run.result === params.result,
					)
					const listed = matched.slice(0, params.limit)
					const failed = listed.filter((run) => CH.isCiFailedResult(run.result))
					const failedIds = failed.map((run) => run.traceId)
					// Jobs can be queued after the window ends: read them over the failed runs' own span.
					const span = CH.ciRunsSpanMs(failed)
					const failedJobs =
						span === undefined
							? []
							: yield* executor.compiledQuery(
									CH.compile(
										CH.ciFailedJobsQuery({
											traceIds: failedIds,
											limit: failedIds.length * FAILED_JOBS_PER_RUN,
										}),
										{
											orgId: executor.orgId,
											startTime: formatWarehouseDateTime(span.startMs),
											endTime: formatWarehouseDateTime(span.endMs),
										},
									),
									{ profile: "list", context: "ciFailedJobs" },
								)
					return {
						runs,
						matched,
						listed,
						failedJobs,
						failedJobsCap: failedIds.length * FAILED_JOBS_PER_RUN,
					}
				}),
			).pipe(
				// A self-hosted ClickHouse gets the CI tables only once an admin applies the schema.
				Effect.catchIf(isMissingCiTables, () =>
					Effect.fail(
						new McpUnavailableError({
							message:
								"This org's warehouse has no CI tables yet. On a self-hosted ClickHouse, apply the schema from its ClickHouse settings page.",
							capability: "ci_runs",
						}),
					),
				),
				Effect.catchTags(warehouseToMcpHandlers(TOOL)),
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", runs.length)

			return {
				timeRange: { start: st, end: et },
				filters: {
					...(params.pipeline === undefined ? undefined : { pipeline: params.pipeline }),
					...(params.repository === undefined ? undefined : { repository: params.repository }),
					...(params.branch === undefined ? undefined : { branch: params.branch }),
					...(params.result === undefined ? undefined : { result: params.result }),
				},
				pipelines: summarize(runs),
				runs: listed.map((run) => ({
					pipeline: run.pipeline,
					repository: run.repository,
					branch: run.branch,
					revision: run.revision,
					runId: run.runId,
					attempt: Math.max(run.attempt, 1),
					trigger: run.trigger,
					result: run.result,
					durationMs: run.durationMs,
					startedAt: DateTime.formatIso(run.startedAt),
					url: run.url,
					traceId: run.traceId,
					failedJobs: failedJobs
						.filter((job) => job.traceId === run.traceId)
						.map((job) => ({
							job: job.job,
							result: job.result,
							reason: job.reason,
							url: job.url,
						})),
				})),
				runsRead: runs.length,
				runsMatched: matched.length,
				summaryCapped: runs.length >= SUMMARY_CAP,
				...(failedJobs.length > 0 && failedJobs.length >= failedJobsCap
					? { failedJobsCapped: true }
					: undefined),
			}
		}),
		render: (output) => {
			const filters = output.filters
			const scope: ReadonlyArray<readonly [string, string | undefined]> = [
				["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
				["Workflow", filters.pipeline],
				["Repository", filters.repository],
				["Branch", filters.branch],
				["Result", filters.result],
			]
			if (output.runsRead === 0) {
				return {
					title: "CI Runs",
					scope,
					empty: {
						message: "No CI workflow runs in this window.",
						hints: [
							"CI runs come from the GitHub integration with CI traces on; list_integrations provider=github shows whether it is.",
							"Widen the window, or drop a filter: workflow, repository and branch names are exact.",
						],
					},
					blocks: [],
				}
			}
			const redPipelines = output.pipelines.flatMap((p) =>
				p.red === undefined ? [] : [{ ...p, red: p.red }],
			)
			const firstFailed = output.runs.find((run) => CH.isCiFailedResult(run.result))
			const next: Array<NextCall> = [
				...redPipelines.flatMap((p) =>
					p.red.lastGreenRevision === undefined ||
					p.red.lastGreenRevision === p.red.firstFailedRevision
						? []
						: [
								doc.next(
									"compare_commits",
									{ base: p.red.lastGreenRevision, head: p.red.firstFailedRevision },
									`the commits that turned ${p.repository} ${p.pipeline} red`,
								),
							],
				),
				...(firstFailed === undefined
					? []
					: [
							doc.next(
								"inspect_trace",
								{ trace_id: firstFailed.traceId },
								"the failed run's job and step waterfall",
							),
						]),
			]
			return {
				title: "CI Runs",
				scope,
				blocks: [
					...(redPipelines.length === 0
						? []
						: [
								doc.heading("Red workflows"),
								doc.list(
									redPipelines.map(
										(p) =>
											`${p.repository} ${p.pipeline}: ${p.red.failedRuns} failed run${p.red.failedRuns === 1 ? "" : "s"} in a row since ${p.red.since}, first on ${p.red.firstFailedRevision.slice(0, 12)}. ` +
											(p.red.lastGreenRevision === undefined
												? "No passing run in this window; widen it to find the last green commit."
												: `Last green: ${p.red.lastGreenRevision.slice(0, 12)} at ${p.red.lastGreenAt}.`),
									),
								),
							]),
					doc.heading("Workflows"),
					...(filters.result === undefined
						? []
						: [
								doc.text(
									`Workflow counts and red streaks cover every result; \`result=${filters.result}\` narrows only the runs listed below.`,
								),
							]),
					doc.table(
						["Repository", "Workflow", "Runs", "Failed", "p50", "p95", "Last"],
						output.pipelines.map((p) => [
							p.repository,
							p.pipeline,
							String(p.runs),
							String(p.failed),
							formatRunDuration(p.p50DurationMs),
							formatRunDuration(p.p95DurationMs),
							`${p.lastResult} at ${p.lastStartedAt}`,
						]),
					),
					...(output.summaryCapped
						? [
								doc.text(
									`Summary over the newest ${output.runsRead} runs only; narrow the window for exact counts.`,
								),
							]
						: []),
					...(output.runs.length === 0
						? [
								doc.text(
									`No run in this window matched \`result=${filters.result ?? "any"}\`; the workflows above count every run read.`,
								),
							]
						: [
								doc.heading("Runs, newest first"),
								...(output.failedJobsCapped === true
									? [
											doc.text(
												"More jobs failed than were read, so some failed runs may list fewer failed jobs. Narrow `limit` or filter by workflow.",
											),
										]
									: []),
								doc.table(
									[
										"Started",
										"Repository",
										"Workflow",
										"Branch",
										"Commit",
										"Result",
										"Duration",
										"Failed jobs",
										"Trace",
									],
									output.runs.map((run) => [
										run.startedAt,
										run.repository,
										run.pipeline,
										run.branch,
										run.revision,
										run.attempt > 1
											? `${run.result} (attempt ${run.attempt})`
											: run.result,
										formatRunDuration(run.durationMs),
										run.failedJobs.length === 0
											? "—"
											: truncate(
													run.failedJobs
														.map((job) =>
															job.reason === ""
																? job.job
																: `${job.job}: ${job.reason}`,
														)
														.join("; "),
													240,
												),
										run.traceId,
									]),
								),
							]),
				],
				...(output.runs.length < output.runsMatched
					? { truncation: { shown: output.runs.length, total: output.runsMatched, noun: "runs" } }
					: undefined),
				next,
			}
		},
	})
}
