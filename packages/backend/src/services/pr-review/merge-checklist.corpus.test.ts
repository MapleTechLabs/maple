import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Array as Arr, Record as Rec, Schema } from "effect"
import { assert, describe, it } from "vitest"
import { detectMergeSteps } from "./merge-checklist"
import {
	type Fraction,
	fractionValue,
	MergeChecklistCase,
	MergeChecklistLabelFile,
	renderCorpusScore,
	scoreCase,
	scoreCorpus,
} from "./merge-checklist-corpus"

const DIR = join(import.meta.dirname, "__fixtures__", "merge-checklist")
const labels = Schema.decodeUnknownSync(Schema.fromJsonString(MergeChecklistLabelFile))(
	readFileSync(join(DIR, "labels.json"), "utf8"),
)
const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(MergeChecklistCase))
const cases = Arr.map(
	Arr.filter(readdirSync(DIR), (name) => name.endsWith(".json") && name !== "labels.json"),
	(name) => decodeCase(readFileSync(join(DIR, name), "utf8")),
)

/** The bars from `docs/pr-review-merge-checklist-plan.md`; raise them as the corpus grows. */
const MIN_RECALL = { secret: 0.95, env: 0.9, migration: 0.95 } as const
const MIN_PRECISION = 0.9
const MAX_NOISE_PER_NEGATIVE = 0.1

describe("before-merge detectors on real pull requests", () => {
	it("has a label for every case and a case for every label", () => {
		assert.sameMembers(
			Arr.map(cases, (item) => item.id),
			Rec.keys(labels),
		)
	})

	it("has a verdict for every name the detectors read; re-snapshot a case when one is missing", () => {
		const unruled = Arr.flatMap(cases, (item) =>
			Arr.map(
				Arr.filter(detectMergeSteps(item.files).names, ({ name }) => !Rec.has(item.verdicts, name)),
				({ name }) => `${item.id}: ${name} (review:checklist <repo> ${item.number} --snapshot)`,
			),
		)
		assert.deepEqual(unruled, [])
	})

	it("finds what a careful reviewer would list, and little else", () => {
		const score = scoreCorpus(Arr.map(cases, (item) => scoreCase(item, labels[item.id]!)))
		// The report is the point when a bar fails: which case missed or over-listed what.
		console.log(`before-merge corpus, ${cases.length} cases\n${renderCorpusScore(score)}`)
		const atLeast = (share: Fraction | undefined, min: number, what: string) => {
			const value = share === undefined ? undefined : fractionValue(share)
			if (value !== undefined) assert.isAtLeast(value, min, what)
		}
		for (const [kind, min] of Rec.toEntries(MIN_RECALL))
			atLeast(score.recall[kind], min, `${kind} recall`)
		atLeast(score.precision, MIN_PRECISION, "precision")
		const noise = fractionValue(score.noise)
		if (noise !== undefined) assert.isAtMost(noise, MAX_NOISE_PER_NEGATIVE, "noise on negative cases")
	})
})
