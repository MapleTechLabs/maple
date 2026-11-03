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
import { DateTime, Effect, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
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

const slug = (value: string) => Str.replace(/[^a-zA-Z0-9.-]+/g, "_")(value)

const tallyOf = (records: ReadonlyArray<TrialRecord>): ReadonlyArray<TaskTally> => {
	const byTask = new Map<string, { trials: number; passes: number }>()
	Arr.forEach(records, (record) => {
		const tally = byTask.get(record.task) ?? { trials: 0, passes: 0 }
		tally.trials += 1
		tally.passes += record.grade.pass ? 1 : 0
		byTask.set(record.task, tally)
	})
	return Arr.map([...byTask], ([task, tally]) => ({ task, ...tally }))
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
	Arr.forEach(records, (record) =>
		Arr.forEach(keys(record), (key) => groups.set(key, [...(groups.get(key) ?? []), record])),
	)
	return Rec.fromEntries(
		Arr.map(
			[...groups].sort(([a], [b]) => Str.localeCompare(b)(a)),
			([key, list]) => [key, group(list)],
		),
	)
}

const summarize = <T extends EvalTask>(
	options: RunOptions<T>,
	dir: string,
	records: ReadonlyArray<TrialRecord>,
): RunSummary => {
	const tallies = tallyOf(records)
	const calls = Arr.flatMap(records, (record) => record.transcript.calls)
	const sum = (values: ReadonlyArray<number>) => Arr.reduce(values, 0, (total, value) => total + value)
	const failing = Arr.map(
		Arr.filter(tallies, (tally) => tally.passes < tally.trials).sort(
			(a, b) => a.passes / a.trials - b.passes / b.trials,
		),
		(tally) => ({
			...tally,
			example:
				records.find((record) => record.task === tally.task && !record.grade.pass)?.grade
					.explanation ?? "",
		}),
	)
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
			errored: Arr.filter(records, (record) => record.transcript.errored).length,
			meanToolCalls: calls.length / Math.max(1, records.length),
			invalidCallRate: Arr.filter(calls, (made) => made.invalid).length / Math.max(1, calls.length),
			toolErrorRate: Arr.filter(calls, (made) => made.isError).length / Math.max(1, calls.length),
			inputTokens: sum(Arr.map(records, (record) => record.transcript.usage.input)),
			outputTokens: sum(Arr.map(records, (record) => record.transcript.usage.output)),
			meanDurationMs:
				sum(Arr.map(records, (record) => record.transcript.durationMs)) / Math.max(1, records.length),
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
		...Arr.map(
			Rec.toEntries(summary.byTier),
			([tier, entry]) => `- ${tier} (${entry.tasks}): ${est(entry.passAt1)}`,
		),
		"",
		"| tag | tasks | pass@1 |",
		"| --- | --- | --- |",
		...Arr.map(
			Rec.toEntries(summary.byTag),
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
					...Arr.flatMap(summary.failing, (entry) => [
						`### ${entry.task} (${entry.passes}/${entry.trials})`,
						"",
						"```",
						Str.slice(0, 1_500)(entry.example),
						"```",
						"",
					]),
				]),
		`Artifacts: ${summary.dir}`,
		"",
	]
	return Arr.join(lines, "\n")
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const encodePrettyJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

export const runSuite = <T extends EvalTask>(options: RunOptions<T>): Effect.Effect<RunSummary> =>
	Effect.gen(function* () {
		const startedAtUtc = yield* DateTime.now
		const startedAt = DateTime.formatIso(startedAtUtc)
		const stamp = Str.replace(/[:.]/g, "-")(startedAt)
		const dir = join(APP_ROOT, ".evals", "runs", `${stamp}-${slug(options.suite)}-${slug(options.model)}`)
		mkdirSync(dir, { recursive: true })
		const manifest = yield* encodePrettyJson({
			suite: options.suite,
			model: options.model,
			k: options.k,
			startedAt,
			revision: git(["rev-parse", "HEAD"]),
			dirty: Arr.filter(Str.split("\n")(git(["status", "--porcelain"])), Boolean),
			tasks: Arr.map(options.tasks, (task) => task.id),
		}).pipe(Effect.orDie)
		writeFileSync(join(dir, "manifest.json"), manifest)
		// Trial-major order: every task's first trial before any second, so a stopped run is balanced.
		const specs = Array.from({ length: options.k }, (_, trial) =>
			Arr.map(options.tasks, (task) => ({ task, trial })),
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
						encodeJson(record).pipe(
							Effect.orDie,
							Effect.flatMap((line) =>
								Effect.sync(() => appendFileSync(join(dir, "trials.jsonl"), `${line}\n`)),
							),
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
		const summaryJson = yield* encodePrettyJson(summary).pipe(Effect.orDie)
		writeFileSync(join(dir, "summary.json"), summaryJson)
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
	tasks: Arr.filter(
		Arr.map(Str.split(",")(process.env.EVAL_TASKS ?? ""), (entry) => Str.trim(entry)),
		Boolean,
	),
})

export const selectTasks = <T extends EvalTask>(
	tasks: ReadonlyArray<T>,
	settings: ReturnType<typeof runSettings>,
) =>
	Arr.filter(
		tasks,
		(task) =>
			(settings.tier === undefined || task.tier === settings.tier) &&
			(settings.tasks.length === 0 ||
				Arr.some(settings.tasks, (selector) =>
					Str.startsWith("tag:")(selector)
						? task.tags.includes(Str.slice(4)(selector))
						: selector === task.id,
				)),
	)
