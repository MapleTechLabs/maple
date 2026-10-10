/**
 * The "before merge" detectors measured on real pull requests. Each case is a pull request's files
 * and the base-commit verdict of every name the diff reads, snapshotted so the eval needs no
 * network (`__fixtures__/merge-checklist/<id>.json`, generated). A person's labels live apart in
 * `labels.json`: the steps a careful reviewer would list, and the ones that are fine either way.
 * `merge-checklist.corpus.test.ts` scores every case in `bun run test`; a case is added with `bun run --cwd apps/ai review:checklist <owner/repo> <n> --snapshot`.
 */
import { mergeStepKey, PullRequestFile } from "@maple/domain/http"
import { Array as Arr, HashSet, Number as Num, Record as Rec, Schema } from "effect"
import {
	buildChecklist,
	detectMergeSteps,
	type NameVerdict,
	NameVerdictSchema,
	type PatchLine,
	patchLines,
	readsNamesIn,
} from "./merge-checklist"

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
	verdicts: Schema.Record(Schema.String, NameVerdictSchema),
})
export type MergeChecklistCase = Schema.Schema.Type<typeof MergeChecklistCase>

/** Every all-caps token in a line: each reader takes the name it reads as one. */
const capsTokens = (text: string): ReadonlyArray<string> =>
	text.match(/(?<![\w$])[A-Z][A-Z0-9_]{2,}(?![\w$])/g) ?? []

/**
 * Kept lines back as a patch: each run of added lines under a hunk header at the line the full
 * patch gives it, removed lines as they were. The accumulator is the line the next added line
 * would continue a run at.
 */
const renderPatch = (lines: ReadonlyArray<PatchLine>): string =>
	Arr.flatten(
		Arr.mapAccum(lines, -1, (next, { kind, text, line }): readonly [number, ReadonlyArray<string>] =>
			kind === "removed"
				? [next, [`-${text}`]]
				: [line + 1, line === next ? [`+${text}`] : [`@@ -0,0 +${line} @@`, `+${text}`]],
		)[1],
	).join("\n")

/**
 * The pull request's files cut to what detection could read. Added lines are kept only in files
 * whose names are read, and only when they hold an all-caps token; removed lines only when they
 * mention a token a kept added line holds, since a removal only matters for a name added
 * somewhere. Every other line only moved the line counter, so kept lines keep the numbers the
 * full patch gives them. The snapshot command checks the cut decides the same steps as the full
 * files.
 */
export const minimizeFiles = (files: ReadonlyArray<PullRequestFile>): ReadonlyArray<PullRequestFile> => {
	const parsed = Arr.map(files, (file) => ({
		file,
		lines: file.patch === null ? Arr.empty<PatchLine>() : patchLines(file.patch),
		readsNames: readsNamesIn(file.path),
	}))
	const addedTokens = HashSet.fromIterable(
		Arr.flatMap(parsed, ({ lines, readsNames }) =>
			Arr.flatMap(lines, (line) => (readsNames && line.kind === "added" ? capsTokens(line.text) : [])),
		),
	)
	return Arr.map(parsed, ({ file, lines, readsNames }) =>
		file.patch === null
			? file
			: {
					...file,
					patch: renderPatch(
						Arr.filter(lines, (line) =>
							line.kind === "added"
								? readsNames && capsTokens(line.text).length > 0
								: Arr.some(capsTokens(line.text), (token) => HashSet.has(addedTokens, token)),
						),
					),
				},
	)
}

/** The step keys the detectors produce for a case, before any reviewer step. */
export const checklistKeys = (input: {
	readonly files: ReadonlyArray<PullRequestFile>
	readonly verdicts: Readonly<Record<string, NameVerdict>>
}): ReadonlyArray<string> =>
	Arr.map(
		buildChecklist({
			detected: detectMergeSteps(input.files),
			verdicts: new Map(Rec.toEntries(input.verdicts)),
			reviewer: [],
			isIgnored: () => false,
		}).steps,
		mergeStepKey,
	)

/** A share: `part` of `whole`. */
export interface Fraction {
	readonly part: number
	readonly whole: number
}

const fraction = (part: number, whole: number): Fraction => ({ part, whole })

/** The share as a number; `undefined` when there is nothing to divide. */
export const fractionValue = ({ part, whole }: Fraction): number | undefined =>
	whole === 0 ? undefined : part / whole

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
	return {
		id: item.id,
		produced,
		hits: Arr.intersection(labels.expected, produced),
		missed: Arr.difference(labels.expected, produced),
		falsePositives: Arr.difference(produced, Arr.union(labels.expected, labels.acceptable)),
		negative: Arr.isReadonlyArrayEmpty(labels.expected) && Arr.isReadonlyArrayEmpty(labels.acceptable),
	}
}

/** The kind a step key starts with: `secret` of `secret:STRIPE_KEY`. */
const kindOf = (key: string) => key.slice(0, key.indexOf(":"))

export interface CorpusScore {
	/** Expected steps found, by kind. */
	readonly recall: Readonly<Record<string, Fraction>>
	/** Listed steps a person expected or accepted, of all listed. */
	readonly precision: Fraction
	/** Steps listed on negative cases, of the negative cases. */
	readonly noise: Fraction
	readonly cases: ReadonlyArray<CaseScore>
}

const total = (scores: ReadonlyArray<CaseScore>, count: (score: CaseScore) => number) =>
	Num.sumAll(Arr.map(scores, count))

export const scoreCorpus = (scores: ReadonlyArray<CaseScore>): CorpusScore => {
	const expected = Arr.flatMap(scores, (score) => [
		...Arr.map(score.hits, (key) => ({ key, found: true })),
		...Arr.map(score.missed, (key) => ({ key, found: false })),
	])
	const listed = total(scores, (score) => score.produced.length)
	const negatives = Arr.filter(scores, (score) => score.negative)
	return {
		recall: Rec.map(
			Arr.groupBy(expected, ({ key }) => kindOf(key)),
			(group) => fraction(Arr.filter(group, ({ found }) => found).length, group.length),
		),
		precision: fraction(listed - total(scores, (score) => score.falsePositives.length), listed),
		noise: fraction(
			total(negatives, (score) => score.produced.length),
			negatives.length,
		),
		cases: scores,
	}
}

const ratio = (share: Fraction) => {
	const value = fractionValue(share)
	return value === undefined ? "n/a" : `${Math.round(value * 100)}% (${share.part}/${share.whole})`
}

/** The score as a short report: the totals, then each case that missed or over-listed. */
export const renderCorpusScore = (score: CorpusScore): string =>
	[
		`recall: ${
			Arr.map(Rec.toEntries(score.recall), ([kind, share]) => `${kind} ${ratio(share)}`).join(", ") ||
			"n/a"
		}`,
		`precision: ${ratio(score.precision)}`,
		`noise: ${score.noise.part} steps on ${score.noise.whole} negative cases`,
		...Arr.map(
			Arr.filter(score.cases, (item) => item.missed.length > 0 || item.falsePositives.length > 0),
			(item) =>
				`  ${item.id}: ${[
					...Arr.map(item.missed, (key) => `missed ${key}`),
					...Arr.map(item.falsePositives, (key) => `listed ${key}`),
				].join(", ")}`,
		),
	].join("\n")
