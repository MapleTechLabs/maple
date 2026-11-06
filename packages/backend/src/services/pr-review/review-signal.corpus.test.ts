import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { confidencePrReview } from "@maple/domain/http"
import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"
import { assert, describe, it } from "vitest"
import {
	parseSummary,
	renderCorpusScore,
	ReviewSignalCase,
	ReviewSignalLabelFile,
	scoreCase,
	scoreCorpus,
	visibleText,
} from "./review-signal-corpus"

const DIR = join(import.meta.dirname, "__fixtures__", "review-signal")
const labels = Schema.decodeSync(Schema.fromJsonString(ReviewSignalLabelFile))(
	readFileSync(join(DIR, "labels.json"), "utf8"),
)
const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewSignalCase))
const cases = Arr.map(
	Arr.filter(readdirSync(DIR), (name) => Str.endsWith(".json")(name) && name !== "labels.json"),
	(name) => decodeCase(readFileSync(join(DIR, name), "utf8")),
)
const scored = Arr.map(cases, (item) => scoreCase(item, labels[item.id]))
const score = scoreCorpus(scored)

/**
 * A published factors line in today's rules. Before #2149 high risk cost its point on its own, so a
 * summary whose only deduction was `risk high −1` now prints plain `risk high`.
 */
const asCurrentRules = (factors: ReadonlyArray<string>): string => {
	const deductions = Arr.filter(factors, (factor) => /−\d+$/.test(factor))
	return Arr.join(
		Arr.map(factors, (factor) =>
			deductions.length === 1 && factor === "risk high −1" ? "risk high" : factor,
		),
		" · ",
	)
}

/** Raise these as the renderer and the confidence improve; lower one only with a reason. */
const MAX_VISIBLE_SHARE = 0.4
const MAX_NEXT_FOUND_AT_9_10 = 0.1

describe("the review comment on real pull requests", () => {
	it("labels only pull requests and heads the corpus has", () => {
		const unknown = Arr.flatMap(Rec.toEntries(labels), ([id, label]) => {
			const item = Option.getOrUndefined(Arr.findFirst(scored, (candidate) => candidate.id === id))
			return Arr.map(
				Arr.filter(
					label.missed,
					(miss) =>
						!(
							item !== undefined &&
							Arr.some(item.reviews, (review) => review.head === miss.head)
						),
				),
				(miss) => `${id}@${miss.head}`,
			)
		})
		assert.deepEqual(unknown, [])
	})

	// The corpus measures nothing if the summaries are not read back into what rendered them: the
	// factors line is recomputed from the parsed report and must match what was published.
	it("reads every published summary back into the report it was rendered from", () => {
		const unread = Arr.flatMap(cases, (item) =>
			Arr.map(
				Arr.filter(
					item.summaries,
					(summary) =>
						/\*\*Confidence \d+\/10\*\*/.test(summary.body) &&
						parseSummary(summary.body) === undefined,
				),
				(summary) => `${item.id} ${summary.createdAt}`,
			),
		)
		assert.deepEqual(unread, [])
		const drifted = Arr.flatMap(scored, (item) =>
			Arr.flatMap(item.reviews, (review) => {
				const factors =
					confidencePrReview(review.parsed.report, review.open, review.parsed.partial)?.factors ??
					[]
				// Published factors predate the history factor; compare what both versions print.
				return Arr.join(factors, " · ") === asCurrentRules(review.parsed.factors)
					? []
					: [
							`${item.id}@${review.head}: ${Arr.join(review.parsed.factors, " · ")} ≠ ${Arr.join(factors, " · ")}`,
						]
			}),
		)
		assert.deepEqual(drifted, [])
	})

	it("shows a reader a fraction of what it did, and says how the number did", () => {
		// The report is the point when a bar fails: what moved, and where.
		console.log(`review signal corpus\n${renderCorpusScore(score)}`)
		assert.isAtMost(score.after.visible / score.before.visible, MAX_VISIBLE_SHARE, "visible share")
	})

	it("never reads safe to merge while a defect is open at the head", () => {
		const offenders = Arr.flatMap(scored, (item) =>
			Arr.map(
				Arr.filter(item.reviews, (review) => review.openDefect && (review.confidence ?? 0) >= 7),
				(review) => `${item.id}@${review.head} reads ${review.confidence}`,
			),
		)
		assert.deepEqual(offenders, [])
	})

	it("holds every labelled miss below safe to merge", () => {
		const unheld = Arr.filter(score.missed, (miss) => miss.after === undefined || miss.after > 8)
		assert.deepEqual(unheld, [])
	})

	// A 9 or 10 is a promise that the next push's review will not turn up a new defect.
	it("keeps its top band honest against what the next review found", () => {
		const top = score.nextFoundByBand.after["9-10 safe"] ?? { found: 0, of: 0 }
		assert.isAbove(top.of, 0)
		assert.isAtMost(top.found / top.of, MAX_NEXT_FOUND_AT_9_10, "next-review defects after a 9 or 10")
	})
})

describe("visibleText", () => {
	it("folds collapsed sections to their summary and links to their label", () => {
		assert.equal(
			visibleText(
				"<!-- marker -->\n## Review\n\n<details><summary>What was checked</summary>\n\n- a long list\n\n</details>\n\nSee [`a.ts:1`](https://x/a.ts#L1).",
			),
			"## Review\n\n▸ What was checked\n\nSee `a.ts:1`.",
		)
	})
})
