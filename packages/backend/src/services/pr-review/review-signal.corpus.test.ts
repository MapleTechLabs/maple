import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { confidencePrReview } from "@maple/domain/http"
import { Array as Arr, Record as Rec, Schema } from "effect"
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
const labels = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewSignalLabelFile))(
	readFileSync(join(DIR, "labels.json"), "utf8"),
)
const decodeCase = Schema.decodeUnknownSync(Schema.fromJsonString(ReviewSignalCase))
const cases = Arr.map(
	Arr.filter(readdirSync(DIR), (name) => name.endsWith(".json") && name !== "labels.json"),
	(name) => decodeCase(readFileSync(join(DIR, name), "utf8")),
)
const scored = Arr.map(cases, (item) => scoreCase(item, labels[item.id]))
const score = scoreCorpus(scored)

/** Raise these as the renderer and the confidence improve; lower one only with a reason. */
const MAX_VISIBLE_SHARE = 0.4
const MAX_NEXT_FOUND_AT_9_10 = 0.1

describe("the review comment on real pull requests", () => {
	it("labels only pull requests and heads the corpus has", () => {
		const unknown = Rec.toEntries(labels).flatMap(([id, label]) => {
			const item = scored.find((candidate) => candidate.id === id)
			return label.missed
				.filter((miss) => item?.reviews.some((review) => review.head === miss.head) !== true)
				.map((miss) => `${id}@${miss.head}`)
		})
		assert.deepEqual(unknown, [])
	})

	// The corpus measures nothing if the summaries are not read back into what rendered them: the
	// factors line is recomputed from the parsed report and must match what was published.
	it("reads every published summary back into the report it was rendered from", () => {
		const unread = cases.flatMap((item) =>
			item.summaries
				.filter(
					(summary) =>
						/\*\*Confidence \d+\/10\*\*/.test(summary.body) &&
						parseSummary(summary.body) === undefined,
				)
				.map((summary) => `${item.id} ${summary.createdAt}`),
		)
		assert.deepEqual(unread, [])
		const drifted = scored.flatMap((item) =>
			item.reviews.flatMap((review) => {
				const factors =
					confidencePrReview(review.parsed.report, review.open, review.parsed.partial)?.factors ??
					[]
				// Published factors predate the history factor; compare what both versions print.
				return factors.join(" · ") === review.parsed.factors.join(" · ")
					? []
					: [
							`${item.id}@${review.head}: ${review.parsed.factors.join(" · ")} ≠ ${factors.join(" · ")}`,
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
		const offenders = scored.flatMap((item) =>
			item.reviews
				.filter((review) => review.openDefect && (review.confidence ?? 0) >= 7)
				.map((review) => `${item.id}@${review.head} reads ${review.confidence}`),
		)
		assert.deepEqual(offenders, [])
	})

	it("holds every labelled miss below safe to merge", () => {
		const unheld = score.missed.filter((miss) => miss.after === undefined || miss.after > 8)
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
