import { PrReviewFinding } from "@maple/domain/http"
import { assert, describe, it } from "vitest"
import { closeOutFindings, parseChildFindings, unaccountedChildFindings } from "./review-child-findings"

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

describe("closeOutFindings", () => {
	const saved = new PrReviewFinding({
		path: "src/a.ts",
		line: 10,
		category: "correctness",
		severity: "warn",
		title: "Saved",
		body: "Why",
	})

	it("files the children's warnings the saved findings do not cover", () => {
		const children = parseChildFindings(
			[
				"src/a.ts:11 | warn | correctness | Same issue | Why | Fix | -",
				"src/b.ts:40 | critical | security | Token in a span | Leaks | Drop it | -",
				"src/b.ts:90 | info | maintainability | Note | Why | Fix | -",
			].join("\n"),
		)
		assert.deepStrictEqual(
			closeOutFindings([saved], children).map((finding) => [finding.path, finding.line, finding.title]),
			[
				["src/a.ts", 10, "Saved"],
				["src/b.ts", 40, "Token in a span"],
			],
		)
	})

	it("files a child's warning when nothing was saved", () => {
		const children = parseChildFindings("src/c.ts:3 | warn | correctness | Race | Why | Fix | -")
		assert.lengthOf(closeOutFindings([], children), 1)
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
