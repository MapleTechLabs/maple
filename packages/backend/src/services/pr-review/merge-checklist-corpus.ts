/**
 * The "before merge" detectors measured on real pull requests. Each case is a pull request's files
 * and the base-commit verdict of every name the diff reads, snapshotted so the eval needs no
 * network (`__fixtures__/merge-checklist/<id>.json`, generated). A person's labels live apart in
 * `labels.json`: the steps a careful reviewer would list, and the ones that are fine either way. `merge-checklist.corpus.test.ts` scores every case in `bun run test`; a case is
 * added with `bun run --cwd apps/ai review:checklist <owner/repo> <n> --snapshot`.
 */
import { mergeStepKey, PullRequestFile } from "@maple/domain/http"
import { Schema } from "effect"
import { buildChecklist, detectMergeSteps, type NameVerdict, readsNamesIn } from "./merge-checklist"

export const MergeChecklistLabels = Schema.Struct({
	/** Step keys (`mergeStepKey`) a careful reviewer would list for this pull request. */
	expected: Schema.Array(Schema.String),
	/** Step keys that are fine to list or to leave out. Anything else listed is a false positive. */
	acceptable: Schema.Array(Schema.String),
	/** Why, for the next person who reads the case. */
	note: Schema.optionalKey(Schema.String),
})
export type MergeChecklistLabels = Schema.Schema.Type<typeof MergeChecklistLabels>

/** Every case's labels by id, kept apart so a re-snapshot never touches what a person wrote. */
export const MergeChecklistLabelFile = Schema.Record(Schema.String, MergeChecklistLabels)

export const MergeChecklistCase = Schema.Struct({
	id: Schema.String,
	repo: Schema.String,
	number: Schema.Number,
	title: Schema.String,
	baseSha: Schema.String,
	headSha: Schema.String,
	/** The files as the provider returns them, patches cut to the lines detection reads. */
	files: Schema.Array(PullRequestFile),
	/** Each name the diff reads, ruled on at the base commit with a whole-word `git grep`. */
	verdicts: Schema.Record(Schema.String, Schema.Literals(["new", "exists", "unverified"])),
})
export type MergeChecklistCase = Schema.Schema.Type<typeof MergeChecklistCase>

/** Every all-caps token in a line: each reader takes the name it reads as one. */
const capsTokens = (text: string) => text.match(/(?<![\w$])[A-Z][A-Z0-9_]{2,}(?![\w$])/g) ?? []

/**
 * The pull request's files cut to what detection could read. Added lines are kept only in files
 * whose names are read, and only when they hold an all-caps token; removed lines only when they
 * mention a token a kept added line holds, since a removal only matters for a name added
 * somewhere. Every other line only moved the line counter, so kept lines sit under one hunk header
 * per run at the number the full patch gives them. The snapshot command checks the cut decides
 * the same steps as the full files.
 */
export const minimizeFiles = (files: ReadonlyArray<PullRequestFile>): ReadonlyArray<PullRequestFile> => {
	const added = new Set(
		files.flatMap((file) =>
			file.patch === null || !readsNamesIn(file.path)
				? []
				: file.patch
						.split("\n")
						.filter((raw) => raw.startsWith("+"))
						.flatMap(capsTokens),
		),
	)
	return files.map((file) => {
		if (file.patch === null) return file
		const keepAdded = readsNamesIn(file.path)
		const out: Array<string> = []
		let line = 0
		let next = -1
		for (const raw of file.patch.split("\n")) {
			const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
			if (hunk !== null) {
				line = Number(hunk[1])
				continue
			}
			if (raw.startsWith("+")) {
				if (keepAdded && capsTokens(raw).length > 0) {
					if (line !== next) out.push(`@@ -0,0 +${line} @@`)
					out.push(raw)
					next = line + 1
				}
				line++
			} else if (raw.startsWith("-")) {
				if (capsTokens(raw).some((token) => added.has(token))) out.push(raw)
			} else if (!raw.startsWith("\\")) {
				line++
			}
		}
		return { ...file, patch: out.join("\n") }
	})
}

/** The step keys the detectors produce for a case, before any reviewer step. */
export const checklistKeys = (input: {
	readonly files: ReadonlyArray<PullRequestFile>
	readonly verdicts: Readonly<Record<string, NameVerdict>>
}): ReadonlyArray<string> =>
	buildChecklist({
		detected: detectMergeSteps(input.files),
		verdicts: new Map(Object.entries(input.verdicts)),
		reviewer: [],
		isIgnored: () => false,
	}).steps.map(mergeStepKey)

export interface CaseScore {
	readonly id: string
	readonly produced: ReadonlyArray<string>
	readonly hits: ReadonlyArray<string>
	readonly missed: ReadonlyArray<string>
	readonly falsePositives: ReadonlyArray<string>
	/** A case where a careful reviewer would list nothing, and nothing is fine to list either. */
	readonly negative: boolean
}

export const scoreCase = (item: MergeChecklistCase, labels: MergeChecklistLabels): CaseScore => {
	const produced = checklistKeys(item)
	const allowed = new Set([...labels.expected, ...labels.acceptable])
	return {
		id: item.id,
		produced,
		hits: labels.expected.filter((key) => produced.includes(key)),
		missed: labels.expected.filter((key) => !produced.includes(key)),
		falsePositives: produced.filter((key) => !allowed.has(key)),
		negative: labels.expected.length === 0 && labels.acceptable.length === 0,
	}
}

const kindOf = (key: string) => key.slice(0, key.indexOf(":"))

export interface CorpusScore {
	/** Expected steps found, by kind: `[hits, expected]`. */
	readonly recall: Readonly<Record<string, readonly [number, number]>>
	/** Listed steps a person expected or accepted: `[correct, listed]`. */
	readonly precision: readonly [number, number]
	/** Steps listed on negative cases: `[steps, cases]`. */
	readonly noise: readonly [number, number]
	readonly cases: ReadonlyArray<CaseScore>
}

export const scoreCorpus = (scores: ReadonlyArray<CaseScore>): CorpusScore => {
	const recall: Record<string, [number, number]> = {}
	for (const score of scores) {
		for (const key of [...score.hits, ...score.missed]) {
			const entry = (recall[kindOf(key)] ??= [0, 0])
			entry[1]++
			if (score.hits.includes(key)) entry[0]++
		}
	}
	const listed = scores.reduce((sum, score) => sum + score.produced.length, 0)
	const wrong = scores.reduce((sum, score) => sum + score.falsePositives.length, 0)
	const negatives = scores.filter((score) => score.negative)
	return {
		recall,
		precision: [listed - wrong, listed],
		noise: [negatives.reduce((sum, score) => sum + score.produced.length, 0), negatives.length],
		cases: scores,
	}
}

const ratio = ([part, whole]: readonly [number, number]) =>
	whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}% (${part}/${whole})`

/** The score as a short report: the totals, then each case that missed or over-listed. */
export const renderCorpusScore = (score: CorpusScore): string =>
	[
		`recall: ${
			Object.entries(score.recall)
				.map(([kind, value]) => `${kind} ${ratio(value)}`)
				.join(", ") || "n/a"
		}`,
		`precision: ${ratio(score.precision)}`,
		`noise: ${score.noise[0]} steps on ${score.noise[1]} negative cases`,
		...score.cases
			.filter((item) => item.missed.length > 0 || item.falsePositives.length > 0)
			.map(
				(item) =>
					`  ${item.id}: ${[
						...item.missed.map((key) => `missed ${key}`),
						...item.falsePositives.map((key) => `listed ${key}`),
					].join(", ")}`,
			),
	].join("\n")
