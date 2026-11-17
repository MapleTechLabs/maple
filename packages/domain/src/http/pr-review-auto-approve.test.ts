/**
 * `prReviewAutoApproval`: when a review may approve a pull request without a person reading it.
 * Every condition has to hold, so each case below breaks exactly one of them on an otherwise
 * approvable report.
 */
import { assert, describe, it } from "vitest"
import {
	PrReviewCoverageUnit,
	PrReviewFinding,
	PrReviewMergeStep,
	PrReviewReport,
	PrReviewRepositoryConfig,
} from "./pr-review"
import { mergePrReviewConfig, prReviewAutoApproval } from "./pr-review-rules"
import { PrReviewContractBreak, PrReviewTelemetry } from "./pr-review-telemetry"

const finding = (
	severity: "critical" | "warn" | "info",
	category: "correctness" | "security" = "correctness",
) => new PrReviewFinding({ path: "a.ts", line: 1, category, severity, title: "t", body: "b" })

const approvable = (overrides: Partial<ConstructorParameters<typeof PrReviewReport>[0]> = {}) =>
	new PrReviewReport({
		verdict: "clean",
		summary: "Renames a label.",
		risk: "low",
		tests: "not_needed",
		wholeDiff: true,
		coverage: [],
		findings: [],
		...overrides,
	})

const unrated = () => {
	const { risk: _risk, ...rest } = approvable()
	return new PrReviewReport(rest)
}

const untested = () => {
	const { tests: _tests, ...rest } = approvable()
	return new PrReviewReport(rest)
}

const telemetryWithBreak = new PrReviewTelemetry({
	windowDays: 7,
	services: [],
	contractBreaks: [
		new PrReviewContractBreak({
			kind: "attribute",
			name: "http.route",
			path: "a.ts",
			line: 3,
			references: [],
		}),
	],
	hotFiles: [],
	linkedIssues: [],
	costNotes: [],
	added: [],
	removed: [],
})

describe("prReviewAutoApproval", () => {
	it("approves a clean, low-risk, fully read change", () => {
		const decision = prReviewAutoApproval({ report: approvable() })
		assert.isTrue(decision.approve)
		assert.include(decision.reason, "confidence 10/10")
	})

	it("approves beside notes: an info finding is not something to fix", () => {
		assert.isTrue(prReviewAutoApproval({ report: approvable({ findings: [finding("info")] }) }).approve)
	})

	it("approves at 9: new work without a span costs a point, not the approval", () => {
		const report = approvable({
			coverage: [
				new PrReviewCoverageUnit({
					unit: "cron",
					kind: "background",
					instrumented: false,
					evidence: "no span",
				}),
			],
		})
		const decision = prReviewAutoApproval({ report })
		assert.isTrue(decision.approve)
		assert.include(decision.reason, "confidence 9/10")
	})

	it("approves covered tests and a ticked step before merge", () => {
		const report = approvable({
			tests: "covered",
			beforeMerge: [
				new PrReviewMergeStep({ kind: "env", title: "Set FOO", source: "diff", done: true }),
			],
		})
		assert.isTrue(prReviewAutoApproval({ report }).approve)
	})

	const refusals: ReadonlyArray<readonly [string, Parameters<typeof prReviewAutoApproval>[0], string]> = [
		["an early end", { report: approvable(), partial: true }, "partial"],
		[
			"a pass over only the latest commits",
			{ report: approvable({ wholeDiff: false }) },
			"not_whole_diff",
		],
		["a diff Maple could not read", { report: approvable(), diffUnavailable: true }, "diff_unavailable"],
		["a file with no patch", { report: approvable(), patchlessFiles: 1 }, "patchless"],
		["a file under an ignored path", { report: approvable(), ignoredFiles: 1 }, "ignored_files"],
		["a warning someone dismissed", { report: approvable(), dismissedIssues: 1 }, "dismissed"],
		[
			"a warning the repository's lenses held back",
			{ report: approvable(), filteredIssues: 1 },
			"filtered",
		],
		["an unread file", { report: approvable({ unreviewed: ["b.ts"] }) }, "unread"],
		["a fix not re-checked", { report: approvable(), uncheckedFixes: 1 }, "unchecked_fixes"],
		["an issues verdict", { report: approvable({ verdict: "issues" }) }, "verdict"],
		["a not-applicable verdict", { report: approvable({ verdict: "not_applicable" }) }, "verdict"],
		["a warning", { report: approvable({ findings: [finding("warn")] }) }, "findings"],
		["a critical", { report: approvable({ findings: [finding("critical", "security")] }) }, "findings"],
		[
			"a warning open from an earlier push",
			{ report: approvable(), carriedOpen: [finding("warn")] },
			"findings",
		],
		["medium risk", { report: approvable({ risk: "medium" }) }, "risk"],
		["high risk", { report: approvable({ risk: "high" }) }, "risk"],
		["an unrated risk", { report: unrated() }, "risk"],
		["missing tests", { report: approvable({ tests: "missing" }) }, "tests"],
		["partial tests", { report: approvable({ tests: "partial" }) }, "tests"],
		["tests not assessed", { report: untested() }, "tests"],
		[
			"an open step before merge",
			{
				report: approvable({
					beforeMerge: [
						new PrReviewMergeStep({ kind: "migration", title: "Run it", source: "diff" }),
					],
				}),
			},
			"merge_steps",
		],
		[
			"an open telemetry contract break",
			{
				report: approvable({ telemetry: telemetryWithBreak }),
			},
			"contract_break",
		],
	]

	for (const [what, input, refusal] of refusals) {
		it(`refuses ${what}`, () => {
			const decision = prReviewAutoApproval(input)
			assert.isFalse(decision.approve)
			if (!decision.approve) assert.equal(decision.refusal, refusal)
		})
	}

	it("names every unmet condition, not only the first", () => {
		const step = (title: string) => new PrReviewMergeStep({ kind: "infra", title, source: "diff" })
		const decision = prReviewAutoApproval({
			report: approvable({
				wholeDiff: false,
				risk: "high",
				tests: "covered",
				beforeMerge: [step("Check staging"), step("Check prod")],
			}),
		})
		assert.isFalse(decision.approve)
		if (!decision.approve) {
			assert.equal(decision.refusal, "not_whole_diff")
			assert.deepEqual(decision.reasons, [
				"the review read only the commits since the last one",
				"the risk is high",
				"2 steps before merge are open",
			])
		}
	})
})

describe("mergePrReviewConfig autoApprove", () => {
	it("takes the repository's choice over the organization's", () => {
		const merged = mergePrReviewConfig(
			new PrReviewRepositoryConfig({ autoApprove: true }),
			new PrReviewRepositoryConfig({ autoApprove: false }),
		)
		assert.isFalse(merged.autoApprove)
	})

	it("inherits the organization's when the repository says nothing", () => {
		const merged = mergePrReviewConfig(
			new PrReviewRepositoryConfig({ autoApprove: true }),
			new PrReviewRepositoryConfig({}),
		)
		assert.isTrue(merged.autoApprove)
	})
})
