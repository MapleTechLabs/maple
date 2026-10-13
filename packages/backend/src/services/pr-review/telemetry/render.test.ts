import {
	PrReviewContractBreak,
	PrReviewCostNote,
	PrReviewFinding,
	PrReviewHotFile,
	PrReviewOperationTraffic,
	PrReviewPostMerge,
	PrReviewTelemetry,
	PrReviewTelemetryReference,
} from "@maple/domain/http"
import { DateTime, Duration } from "effect"
import { assert, describe, it } from "vitest"
import {
	comparedOperations,
	missingAfterDeploy,
	operationRegressed,
	pickDeploy,
	POST_MERGE_EXACT_WAIT,
	renderPostMergeComment,
} from "./post-merge"
import {
	escapeCell,
	fixedContractBreaks,
	lineStillEmits,
	renderTelemetryKickoff,
	renderTelemetryMarkdown,
	telemetryFindings,
	weighByTraffic,
	withDismissals,
} from "./render"

const alertBreak = new PrReviewContractBreak({
	kind: "attribute",
	name: "payment.provider",
	path: "src/pay.ts",
	line: 12,
	references: [
		new PrReviewTelemetryReference({ kind: "alert", id: "rule-1", name: "Checkout by provider" }),
	],
	perDay: 1_000,
})
const dashboardBreak = new PrReviewContractBreak({
	kind: "span",
	name: "Payments.charge",
	path: "src/pay.ts",
	line: 30,
	references: [new PrReviewTelemetryReference({ kind: "dashboard", id: "d-1", name: "Payments" })],
	perDay: 50,
})
const hot = new PrReviewHotFile({
	path: "src/checkout.ts",
	perDay: 41_000,
	operations: [
		new PrReviewOperationTraffic({
			service: "api",
			spanName: "POST /checkout",
			perDay: 41_000,
			errorRate: 0.01,
			p95Ms: 300,
		}),
	],
})

const telemetry = (overrides: Partial<ConstructorParameters<typeof PrReviewTelemetry>[0]> = {}) =>
	new PrReviewTelemetry({
		windowDays: 7,
		services: ["api"],
		contractBreaks: [alertBreak, dashboardBreak],
		hotFiles: [hot],
		linkedIssues: [],
		costNotes: [],
		added: [],
		removed: [],
		...overrides,
	})

const finding = (overrides: Partial<ConstructorParameters<typeof PrReviewFinding>[0]> = {}) =>
	new PrReviewFinding({
		path: "src/checkout.ts",
		line: 3,
		category: "observability",
		checkId: "SPAN-03",
		severity: "info",
		title: "No span on the retry branch",
		body: "The retry is invisible.",
		...overrides,
	})

describe("telemetryFindings", () => {
	it("files an alert break as critical and a dashboard break as a warning", () => {
		const findings = telemetryFindings(telemetry())
		assert.deepStrictEqual(
			findings.map((item) => [item.checkId, item.severity, item.title]),
			[
				[
					"TEL-01",
					"critical",
					"Removes `payment.provider`, which alert “Checkout by provider” reads",
				],
				["TEL-01", "warn", "Removes `Payments.charge`, which dashboard “Payments” reads"],
			],
		)
	})

	it("files a costly log line and a templated span name, and keeps cheap logs to the summary", () => {
		const findings = telemetryFindings(
			telemetry({
				contractBreaks: [],
				costNotes: [
					new PrReviewCostNote({ path: "a.ts", line: 1, kind: "log", gbPerMonth: 12, note: "n" }),
					new PrReviewCostNote({ path: "a.ts", line: 2, kind: "log", gbPerMonth: 0.4, note: "n" }),
					new PrReviewCostNote({ path: "a.ts", line: 3, kind: "span_name", note: "n" }),
				],
			}),
		)
		assert.deepStrictEqual(
			findings.map((item) => [item.checkId, item.severity, item.line]),
			[
				["TEL-02", "warn", 1],
				["TEL-03", "warn", 3],
			],
		)
	})

	it("drops a break the reviewer proved is still emitted", () => {
		const proved = withDismissals(telemetry(), [
			{ name: "payment.provider", path: "src/other.ts", line: 4 },
		])
		assert.deepStrictEqual(
			telemetryFindings(proved).map((item) => item.title.split(",")[0]),
			["Removes `Payments.charge`"],
		)
		assert.deepStrictEqual(proved.contractBreaks[0]?.dismissed, { path: "src/other.ts", line: 4 })
	})
})

describe("weighByTraffic", () => {
	it("raises an observability note in a busy file to a warning and says why", () => {
		const [raised] = weighByTraffic([finding()], telemetry())
		assert.strictEqual(raised?.severity, "warn")
		assert.include(raised?.body ?? "", "41k calls a day")
	})

	it("leaves other lenses, quiet files and existing warnings alone", () => {
		const kept = [
			new PrReviewFinding({
				path: "src/checkout.ts",
				line: 3,
				category: "correctness",
				severity: "info",
				title: "t",
				body: "b",
			}),
			finding({ path: "src/quiet.ts" }),
			finding({ severity: "warn" }),
		]
		assert.deepStrictEqual(weighByTraffic(kept, telemetry()), kept)
	})
})

describe("lineStillEmits", () => {
	it("accepts only a telemetry call of the same kind, never a comment, log or plain string", () => {
		const content = [
			"a",
			'span.setAttribute("payment.provider", p)',
			'// "payment.provider"',
			'console.log("payment.provider")',
			'const note = "payment.provider"',
			"Effect.annotateCurrentSpan({",
			'	"payment.provider": p,',
		].join("\n")
		assert.isTrue(lineStillEmits(content, 2, "payment.provider", "attribute"))
		assert.isFalse(lineStillEmits(content, 2, "payment.provider", "span"))
		assert.isFalse(lineStillEmits(content, 3, "payment.provider", "attribute"))
		assert.isFalse(lineStillEmits(content, 4, "payment.provider", "attribute"))
		assert.isFalse(lineStillEmits(content, 5, "payment.provider", "attribute"))
		assert.isTrue(lineStillEmits(content, 7, "payment.provider", "attribute"))
		assert.isFalse(lineStillEmits(content, 99, "payment.provider", "attribute"))
	})

	it("escapes table cells so a backslash cannot unescape a pipe", () => {
		assert.strictEqual(escapeCell("a\\|b\nc"), "a\\\\\\|b c")
	})
})

describe("fixedContractBreaks", () => {
	it("resolves an earlier break the pull request no longer causes", () => {
		const open = [
			{ title: "Removes `payment.provider`, which alert “x” reads", category: "observability" },
			{ title: "Removes `gone.key`, which alert “x” reads", category: "observability" },
		]
		assert.deepStrictEqual(
			fixedContractBreaks(open, telemetry()).map((item) => item.title),
			["Removes `gone.key`, which alert “x” reads"],
		)
		assert.deepStrictEqual(fixedContractBreaks(open, undefined), [])
	})
})

describe("rendering", () => {
	it("states the breaks and traffic in the kickoff", () => {
		const text = renderTelemetryKickoff(telemetry()).join("\n")
		assert.include(text, "`payment.provider` (attribute, ~1.0k/day) removed at src/pay.ts:12")
		assert.include(text, "telemetryDismissals")
		assert.include(text, "src/checkout.ts: ~41k calls/day")
	})

	it("says the check blocks only when the repository asked", () => {
		assert.include(
			renderTelemetryMarkdown(telemetry(), { blocking: true }).join("\n"),
			"This check fails",
		)
		assert.notInclude(
			renderTelemetryMarkdown(telemetry(), { blocking: false }).join("\n"),
			"This check fails",
		)
		assert.deepStrictEqual(renderTelemetryMarkdown(undefined, { blocking: false }), [])
	})
})

describe("post-merge", () => {
	const at = (iso: string) => DateTime.makeUnsafe(iso)
	const merged = at("2026-10-07T10:00:00Z")
	const exactWaitOver = DateTime.addDuration(merged, POST_MERGE_EXACT_WAIT)
	const versions = [
		{
			service: "api",
			environment: "production",
			commitSha: "bbb",
			firstSeen: at("2026-10-07T10:10:00Z"),
		},
		{
			service: "api",
			environment: "production",
			commitSha: "AAA",
			firstSeen: at("2026-10-07T10:20:00Z"),
		},
	]

	const pick = (mergeCommitSha: string | null, overrides: Partial<Parameters<typeof pickDeploy>[0]> = {}) =>
		pickDeploy({
			versions,
			mergeCommitSha,
			mergedAt: merged,
			now: exactWaitOver,
			commitTimes: new Map(),
			exactOnly: false,
			...overrides,
		})

	it("prefers the merge commit's own version, else the first one after the merge", () => {
		assert.deepStrictEqual(pick("aaa"), { deploy: versions[1], exact: true })
		assert.deepStrictEqual(pick("ccc"), { deploy: versions[0], exact: false })
		const later = at("2026-10-07T11:00:00Z")
		assert.isUndefined(
			pick(null, { mergedAt: later, now: DateTime.addDuration(later, POST_MERGE_EXACT_WAIT) }),
		)
	})

	it("ignores a version of the merge commit first seen before the merge", () => {
		assert.deepStrictEqual(pick("aaa", { mergedAt: at("2026-10-07T10:30:00Z") }), undefined)
	})

	it("waits for the merge commit before a later version stands in", () => {
		assert.isUndefined(
			pick("ccc", { now: DateTime.subtractDuration(exactWaitOver, Duration.seconds(1)) }),
		)
		assert.deepStrictEqual(pick("aaa", { now: at("2026-10-07T10:25:00Z") }), {
			deploy: versions[1],
			exact: true,
		})
	})

	it("never stands in a version whose commit predates the merge, nor any when only the exact one will do", () => {
		assert.deepStrictEqual(pick("ccc", { commitTimes: new Map([["bbb", at("2026-10-07T09:00:00Z")]]) }), {
			deploy: versions[1],
			exact: false,
		})
		assert.isUndefined(pick("ccc", { exactOnly: true }))
	})

	it("calls a jump in error rate or latency a regression, never noise", () => {
		const base = { service: "api", spanName: "x", count: 100, errorCount: 1, p95Ms: 200 }
		assert.isTrue(operationRegressed(base, { ...base, errorCount: 8 }))
		assert.isTrue(operationRegressed(base, { ...base, p95Ms: 400 }))
		assert.isFalse(operationRegressed(base, { ...base, p95Ms: 250 }))
		assert.isFalse(operationRegressed(base, { ...base, count: 5, errorCount: 5 }))
	})

	it("compares the busiest operations and finds names that stopped arriving", () => {
		assert.deepStrictEqual(
			comparedOperations(telemetry()).map((operation) => operation.spanName),
			["POST /checkout"],
		)
		assert.deepStrictEqual(missingAfterDeploy(telemetry(), new Set(["http.route"])), ["payment.provider"])
	})

	it("renders a clean follow-up", () => {
		const body = renderPostMergeComment(
			"r-1",
			new PrReviewPostMerge({
				deploy: {
					service: "api",
					environment: "production",
					commitSha: "abcdef123",
					firstSeen: DateTime.makeUnsafe(0),
					exact: true,
				},
				windowMinutes: 60,
				operations: [],
				newIssues: [],
				linkedIssues: [],
				missing: [],
				verdict: "clean",
			}),
		)
		assert.include(body, "<!-- maple-pr-post-merge r-1 -->")
		assert.include(body, "Shipped clean")
		assert.include(body, "`abcdef1`")
	})
})
