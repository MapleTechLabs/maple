/**
 * Runs a suite: every task k times, each trial graded, every transcript kept.
 *
 * Shaped after UK AISI's Inspect (dataset, solver, scorer, epochs, logs). A run writes
 * `apps/ai/.evals/runs/<stamp>-<suite>-<model>/`:
 *
 * - `manifest.json`: suite, model, k, git revision and dirty files, task ids.
 * - `trials.jsonl`: one line per trial, with the full grade and transcript.
 * - `summary.json` / `summary.md`: the numbers, and the failing tasks with a failing transcript's
 *   explanation, which is where reading starts.
 *
 * Compare two runs with `bun run eval:compare <runA> <runB>`.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import type { Transcript } from "./chat-turn"
import { passAt1, passAtK, passHatK, type Estimate, type TaskTally } from "./stats"
import type { Grade } from "./targets"

export interface EvalTask {
	readonly id: string
	/**
	 * `regression`: saturated, expected to pass every time; a miss fails CI.
	 * `capability`: still hard; tracked, never gating.
	 */
	readonly tier: "regression" | "capability"
	readonly tags: ReadonlyArray<string>
}

export interface TrialRecord {
	readonly task: string
	readonly trial: number
	readonly tier: EvalTask["tier"]
	readonly tags: ReadonlyArray<string>
	readonly grade: Grade
	readonly transcript: Transcript
}

export interface RunOptions<T extends EvalTask> {
	readonly suite: string
	readonly model: string
	readonly tasks: ReadonlyArray<T>
	readonly k: number
	readonly concurrency: number
	readonly trial: (task: T) => Effect.Effect<{ readonly grade: Grade; readonly transcript: Transcript }>
}

export interface GroupSummary {
	readonly tasks: number
	readonly passAt1: Estimate
}

export interface RunSummary {
	readonly suite: string
	readonly model: string
	readonly k: number
	readonly dir: string
	readonly overall: GroupSummary
	/** Equal to pass@1 when k is 1. */
	readonly passHatK: number
	readonly passAtK: number
	readonly byTier: Readonly<Record<string, GroupSummary>>
	readonly byTag: Readonly<Record<string, GroupSummary>>
	readonly tallies: ReadonlyArray<TaskTally>
	readonly cost: {
		readonly trials: number
		readonly errored: number
		readonly meanToolCalls: number
		readonly invalidCallRate: number
		readonly toolErrorRate: number
		readonly inputTokens: number
		readonly outputTokens: number
		readonly meanDurationMs: number
	}
	readonly failing: ReadonlyArray<{
		readonly task: string
		readonly passes: number
		readonly trials: number
		readonly example: string
	}>
}

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const git = (args: ReadonlyArray<string>): string =>
	spawnSync("git", args, { cwd: APP_ROOT, encoding: "utf8" }).stdout?.trim() ?? ""

const slug = (value: string) => value.replace(/[^a-zA-Z0-9.-]+/g, "_")

const tallyOf = (records: ReadonlyArray<TrialRecord>): ReadonlyArray<TaskTally> => {
	const byTask = new Map<string, { trials: number; passes: number }>()
	records.forEach((record) => {
		const tally = byTask.get(record.task) ?? { trials: 0, passes: 0 }
		tally.trials += 1
		tally.passes += record.grade.pass ? 1 : 0
		byTask.set(record.task, tally)
	})
	return [...byTask].map(([task, tally]) => ({ task, ...tally }))
}

const group = (records: ReadonlyArray<TrialRecord>): GroupSummary => {
	const tallies = tallyOf(records)
	return { tasks: tallies.length, passAt1: passAt1(tallies) }
}

const groupBy = (
	records: ReadonlyArray<TrialRecord>,
	keys: (record: TrialRecord) => ReadonlyArray<string>,
) => {
	const groups = new Map<string, Array<TrialRecord>>()
	records.forEach((record) =>
		keys(record).forEach((key) => groups.set(key, [...(groups.get(key) ?? []), record])),
	)
	return Object.fromEntries(
		[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => [key, group(list)]),
	)
}

const summarize = <T extends EvalTask>(
	options: RunOptions<T>,
	dir: string,
	records: ReadonlyArray<TrialRecord>,
): RunSummary => {
	const tallies = tallyOf(records)
	const calls = records.flatMap((record) => record.transcript.calls)
	const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0)
	const failing = tallies
		.filter((tally) => tally.passes < tally.trials)
		.sort((a, b) => a.passes / a.trials - b.passes / b.trials)
		.map((tally) => ({
			...tally,
			example:
				records.find((record) => record.task === tally.task && !record.grade.pass)?.grade
					.explanation ?? "",
		}))
	return {
		suite: options.suite,
		model: options.model,
		k: options.k,
		dir,
		overall: group(records),
		passHatK: passHatK(tallies, options.k),
		passAtK: passAtK(tallies, options.k),
		byTier: groupBy(records, (record) => [record.tier]),
		byTag: groupBy(records, (record) => record.tags),
		tallies,
		cost: {
			trials: records.length,
			errored: records.filter((record) => record.transcript.errored).length,
			meanToolCalls: calls.length / Math.max(1, records.length),
			invalidCallRate: calls.filter((made) => made.invalid).length / Math.max(1, calls.length),
			toolErrorRate: calls.filter((made) => made.isError).length / Math.max(1, calls.length),
			inputTokens: sum(records.map((record) => record.transcript.usage.input)),
			outputTokens: sum(records.map((record) => record.transcript.usage.output)),
			meanDurationMs:
				sum(records.map((record) => record.transcript.durationMs)) / Math.max(1, records.length),
		},
		failing,
	}
}

const pct = (value: number) => (Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(1)}%`)
const est = (estimate: Estimate) =>
	`${pct(estimate.mean)} ± ${pct(1.96 * estimate.se)} (95% CI ${pct(estimate.low)} to ${pct(estimate.high)})`

export const renderSummary = (summary: RunSummary): string => {
	const lines = [
		`# ${summary.suite} eval: ${summary.model}`,
		"",
		`k=${summary.k} · ${summary.overall.tasks} tasks · ${summary.cost.trials} trials · ${summary.cost.errored} errored`,
		"",
		`- pass@1: ${est(summary.overall.passAt1)}`,
		...(summary.k === 1
			? []
			: [
					`- pass^${summary.k} (all trials pass): ${pct(summary.passHatK)}`,
					`- pass@${summary.k} (any trial passes): ${pct(summary.passAtK)}`,
				]),
		...Object.entries(summary.byTier).map(
			([tier, entry]) => `- ${tier} (${entry.tasks}): ${est(entry.passAt1)}`,
		),
		"",
		"| tag | tasks | pass@1 |",
		"| --- | --- | --- |",
		...Object.entries(summary.byTag).map(
			([tag, entry]) => `| ${tag} | ${entry.tasks} | ${pct(entry.passAt1.mean)} |`,
		),
		"",
		`Cost per trial: ${summary.cost.meanToolCalls.toFixed(1)} tool calls, ` +
			`${Math.round(summary.cost.inputTokens / Math.max(1, summary.cost.trials))} input / ` +
			`${Math.round(summary.cost.outputTokens / Math.max(1, summary.cost.trials))} output tokens, ` +
			`${(summary.cost.meanDurationMs / 1000).toFixed(1)} s. ` +
			`Invalid calls ${pct(summary.cost.invalidCallRate)}, tool errors ${pct(summary.cost.toolErrorRate)}.`,
		"",
		...(summary.failing.length === 0
			? ["Every task passed every trial."]
			: [
					"## Failing tasks",
					"",
					...summary.failing.flatMap((entry) => [
						`### ${entry.task} (${entry.passes}/${entry.trials})`,
						"",
						"```",
						entry.example.slice(0, 1_500),
						"```",
						"",
					]),
				]),
		`Artifacts: ${summary.dir}`,
		"",
	]
	return lines.join("\n")
}

export const runSuite = <T extends EvalTask>(options: RunOptions<T>): Effect.Effect<RunSummary> =>
	Effect.gen(function* () {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-")
		const dir = join(APP_ROOT, ".evals", "runs", `${stamp}-${slug(options.suite)}-${slug(options.model)}`)
		mkdirSync(dir, { recursive: true })
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify(
				{
					suite: options.suite,
					model: options.model,
					k: options.k,
					startedAt: new Date().toISOString(),
					revision: git(["rev-parse", "HEAD"]),
					dirty: git(["status", "--porcelain"]).split("\n").filter(Boolean),
					tasks: options.tasks.map((task) => task.id),
				},
				null,
				2,
			),
		)
		// Trial-major order: every task's first trial before any second, so a stopped run is balanced.
		const specs = Array.from({ length: options.k }, (_, trial) =>
			options.tasks.map((task) => ({ task, trial })),
		).flat()
		const records = yield* Effect.forEach(
			specs,
			({ task, trial }) =>
				options.trial(task).pipe(
					Effect.map(({ grade, transcript }): TrialRecord => ({
						task: task.id,
						trial,
						tier: task.tier,
						tags: task.tags,
						grade,
						transcript,
					})),
					Effect.tap((record) =>
						Effect.sync(() =>
							appendFileSync(join(dir, "trials.jsonl"), `${JSON.stringify(record)}\n`),
						).pipe(
							Effect.andThen(
								Effect.logInfo(
									`[eval] ${record.grade.pass ? "pass" : "FAIL"} ${record.task}#${record.trial}`,
								),
							),
						),
					),
				),
			{ concurrency: options.concurrency },
		)
		const summary = summarize(options, dir, records)
		writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 2))
		writeFileSync(join(dir, "summary.md"), renderSummary(summary))
		return summary
	})

const intFromEnv = (name: string, fallback: number): number => {
	const value = Number(process.env[name])
	return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Run settings from the environment: `EVAL_K`, `EVAL_CONCURRENCY`, `EVAL_TIER`, `EVAL_TASKS`. */
export const runSettings = () => ({
	k: intFromEnv("EVAL_K", 1),
	concurrency: intFromEnv("EVAL_CONCURRENCY", 4),
	tier:
		process.env.EVAL_TIER === "regression" || process.env.EVAL_TIER === "capability"
			? process.env.EVAL_TIER
			: undefined,
	/** Comma-separated task ids or `tag:<tag>` selectors. */
	tasks: (process.env.EVAL_TASKS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean),
})

export const selectTasks = <T extends EvalTask>(
	tasks: ReadonlyArray<T>,
	settings: ReturnType<typeof runSettings>,
) =>
	tasks.filter(
		(task) =>
			(settings.tier === undefined || task.tier === settings.tier) &&
			(settings.tasks.length === 0 ||
				settings.tasks.some((selector) =>
					selector.startsWith("tag:")
						? task.tags.includes(selector.slice(4))
						: selector === task.id,
				)),
	)
