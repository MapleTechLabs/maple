import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { assert, describe, it } from "vitest"
import { detectMergeSteps } from "./merge-checklist"
import {
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
const cases = readdirSync(DIR)
	.filter((name) => name.endsWith(".json") && name !== "labels.json")
	.map((name) =>
		Schema.decodeUnknownSync(Schema.fromJsonString(MergeChecklistCase))(
			readFileSync(join(DIR, name), "utf8"),
		),
	)

/** The bars from `docs/pr-review-merge-checklist-plan.md`; raise them as the corpus grows. */
const MIN_RECALL = { secret: 0.95, env: 0.9, migration: 0.95 } as const
const MIN_PRECISION = 0.9
const MAX_NOISE_PER_NEGATIVE = 0.1

describe("before-merge detectors on real pull requests", () => {
	it("has a label for every case and a case for every label", () => {
		assert.sameMembers(
			cases.map((item) => item.id),
			Object.keys(labels),
		)
	})

	it("has a verdict for every name the detectors read; re-snapshot a case when one is missing", () => {
		for (const item of cases) {
			const unruled = detectMergeSteps(item.files)
				.names.map(({ name }) => name)
				.filter((name) => !(name in item.verdicts))
			assert.deepEqual(unruled, [], `${item.id}: review:checklist ... ${item.number} --snapshot`)
		}
	})

	it("finds what a careful reviewer would list, and little else", () => {
		const score = scoreCorpus(cases.map((item) => scoreCase(item, labels[item.id]!)))
		// The report is the point when a bar fails: which case missed or over-listed what.
		console.log(`before-merge corpus, ${cases.length} cases\n${renderCorpusScore(score)}`)
		for (const [kind, min] of Object.entries(MIN_RECALL)) {
			const [hits, expected] = score.recall[kind] ?? [0, 0]
			if (expected > 0) assert.isAtLeast(hits / expected, min, `${kind} recall`)
		}
		const [correct, listed] = score.precision
		if (listed > 0) assert.isAtLeast(correct / listed, MIN_PRECISION, "precision")
		const [noise, negatives] = score.noise
		if (negatives > 0)
			assert.isAtMost(noise / negatives, MAX_NOISE_PER_NEGATIVE, "noise on negative cases")
	})
})
