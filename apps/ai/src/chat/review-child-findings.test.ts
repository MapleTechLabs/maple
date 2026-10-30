import { PrReviewFinding } from "@maple/domain/http"
import { assert, describe, it } from "vitest"
import { parseChildFindings, unaccountedChildFindings } from "./review-child-findings"

const anchors = (answer: string) =>
	parseChildFindings(answer).map((finding) => [finding.path, finding.line, finding.severity])

describe("parseChildFindings", () => {
	it("reads the anchor through a list bullet and backticks", () => {
		assert.deepStrictEqual(
			anchors(
				[
					"- src/capture.ts:213 | warn | correctness | Race | Acks early | Enqueue later | -",
					"* `src/queue.ts:9` | warn | correctness | Race | Acks early | Enqueue later | -",
					"`src/worker.ts`:40 | warn | correctness | Race | Acks early | Enqueue later | -",
				].join("\n"),
			),
			[
				["src/capture.ts", 213, "warn"],
				["src/queue.ts", 9, "warn"],
				["src/worker.ts", 40, "warn"],
			],
		)
	})

	it("reads severities the way the review posts them", () => {
		const line = (severity: string) => `src/a.ts:1 | ${severity} | correctness | Title | Why | Fix | -`
		assert.deepStrictEqual(
			anchors(["warning", "**warn**", "Critical", "info", "note", "high"].map(line).join("\n")).map(
				([, , severity]) => severity,
			),
			["warn", "warn", "critical", "info", "info", "warn"],
		)
	})

	it("skips prose and NO FINDINGS", () => {
		assert.deepStrictEqual(anchors("NO FINDINGS"), [])
		assert.deepStrictEqual(anchors("Looked at src/a.ts:1 and found nothing | really"), [])
	})
})

describe("unaccountedChildFindings", () => {
	it("lets one filed finding account for one of two nearby warnings", () => {
		const children = parseChildFindings(
			[
				"src/a.ts:10 | warn | correctness | A | Why | Fix | -",
				"src/a.ts:12 | warn | security | B | Why | Fix | -",
			].join("\n"),
		)
		const filed = new PrReviewFinding({
			path: "src/a.ts",
			line: 11,
			category: "correctness",
			severity: "warn",
			title: "A",
			body: "Why",
		})
		assert.lengthOf(unaccountedChildFindings(children, [filed], []), 1)
	})

	it("gates every severity but a note", () => {
		const children = parseChildFindings(
			[
				"src/a.ts:10 | warning | correctness | A | Why | Fix | -",
				"src/a.ts:90 | info | maintainability | B | Why | Fix | -",
			].join("\n"),
		)
		assert.deepStrictEqual(
			unaccountedChildFindings(children, [], []).map((finding) => finding.line),
			[10],
		)
	})
})
