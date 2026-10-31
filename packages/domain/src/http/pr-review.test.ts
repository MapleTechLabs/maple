/**
 * `normalizePrReviewSubmission`: what a model's submission becomes, and what it never becomes.
 *
 * The schema at the tool boundary is lenient on purpose (see `AiTriageSubmission` for the
 * incident that made it so), which moves every guarantee a reader relies on into this function.
 */
import { assert, describe, it } from "vitest"
import {
	confidencePrReview,
	mentionsReviewer,
	normalizePrReviewFinding,
	normalizePrReviewSubmission,
	parseReplyCommand,
	reviewerMention,
	prReviewFailureReason,
	PrReviewReport,
	scorePrReview,
} from "./pr-review"

describe("normalizePrReviewSubmission", () => {
	it("keeps a finding that names a file and a new-side line", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			verdict: "issues",
			summary: "Adds a route with no span.",
			findings: [
				{
					path: "src/routes/orders.ts",
					line: 42,
					endLine: 48,
					checkId: "span-03",
					severity: "warn",
					title: "New POST /orders handler has no server span",
					body: "Wrap the handler in withSpan.",
				},
			],
		})
		assert.equal(droppedFindings, 0)
		assert.equal(report.verdict, "issues")
		assert.equal(report.findings.length, 1)
		const finding = report.findings[0]!
		assert.equal(finding.path, "src/routes/orders.ts")
		assert.equal(finding.line, 42)
		assert.equal(finding.endLine, 48)
		// Check ids are audit ids, and the audit spells them upper case.
		assert.equal(finding.checkId, "SPAN-03")
		assert.equal(finding.category, "observability")
		assert.equal(finding.severity, "warn")
	})

	it("keeps key changes and checks as trimmed bullets, however the list arrived", () => {
		const { report } = normalizePrReviewSubmission({
			verdict: "clean",
			summary: "Adds a retry.",
			keyChanges: ["- `retryFetch` retries GETs twice", "  ", "* Adds a jittered backoff"],
			checked: JSON.stringify(["POSTs are not retried (`client.ts:40`)"]),
		})
		assert.deepEqual(report.keyChanges, ["`retryFetch` retries GETs twice", "Adds a jittered backoff"])
		assert.deepEqual(report.checked, ["POSTs are not retried (`client.ts:40`)"])
		const bare = normalizePrReviewSubmission({ verdict: "clean", summary: "x", keyChanges: [] }).report
		assert.isUndefined(bare.keyChanges)
		assert.isUndefined(bare.checked)
	})

	it("reads a list the model sent as its JSON text", () => {
		// glm-5.3-flash sent `findings` as a string in prod; a strict decode ended the review early.
		const { report } = normalizePrReviewSubmission({
			findings: JSON.stringify([{ path: "src/a.ts", line: 3, title: "kept" }]),
			coverage: JSON.stringify([{ unit: "GET /a", instrumented: true }]),
			resolved: '["f1"]',
		})
		assert.deepEqual(
			report.findings.map((finding) => finding.title),
			["kept"],
		)
		assert.equal(report.coverage[0]?.unit, "GET /a")
		assert.deepEqual(normalizePrReviewSubmission({ findings: "not json", resolved: '["f2"]' }).resolved, [
			"F2",
		])
		assert.equal(normalizePrReviewSubmission({ findings: "not json" }).report.findings.length, 0)
	})

	it("drops a finding it cannot anchor to a line rather than inventing one", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			findings: [
				{ path: "src/a.ts", checkId: "SPAN-01", title: "no line" },
				{ line: 3, title: "no path" },
				{ path: "src/a.ts", checkId: "SPAN-01", line: 0, title: "line zero" },
				{ path: "src/a.ts", checkId: "SPAN-01", line: 7, title: "kept" },
			],
		})
		assert.equal(droppedFindings, 3)
		assert.deepEqual(
			report.findings.map((finding) => finding.title),
			["kept"],
		)
	})

	it("drops an observability finding whose check id the audit does not have", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			findings: [
				{ path: "src/a.ts", line: 1, category: "observability", title: "no id" },
				{ path: "src/a.ts", line: 2, category: "observability", checkId: "OBS-7", title: "made up" },
				{ path: "src/a.ts", line: 3, checkId: "ren-dual", title: "kept" },
			],
		})
		assert.equal(droppedFindings, 2)
		assert.deepEqual(
			report.findings.map((finding) => finding.checkId),
			["REN-DUAL"],
		)
	})

	it("keeps a finding outside observability without a check id, and strips a stray one", () => {
		const { report, droppedFindings } = normalizePrReviewSubmission({
			findings: [
				{
					path: "src/a.ts",
					line: 1,
					category: "security",
					checkId: "SPAN-01",
					title: "tenant check",
				},
				{ path: "src/a.ts", line: 2, title: "off by one" },
				{ path: "src/a.ts", line: 3, category: "style", title: "unknown category" },
			],
		})
		assert.equal(droppedFindings, 0)
		assert.deepEqual(
			report.findings.map((finding) => [finding.category, finding.checkId]),
			[
				["security", undefined],
				["correctness", undefined],
				["correctness", undefined],
			],
		)
	})

	it("keeps a replacement's indentation and drops its trailing newlines", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [
				{
					path: "src/a.ts",
					line: 4,
					endLine: 5,
					title: "x",
					replacement: "\tif (a) {\n\t\treturn b\n\n",
				},
			],
		})
		assert.equal(report.findings[0]!.replacement, "\tif (a) {\n\t\treturn b")
	})

	it("derives the verdict from the findings when the model gave none", () => {
		const gaps = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "warn", title: "gap" }],
		})
		assert.equal(gaps.report.verdict, "issues")
		const infoOnly = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "info", title: "nicety" }],
		})
		assert.equal(infoOnly.report.verdict, "clean")
		const nothing = normalizePrReviewSubmission({})
		assert.equal(nothing.report.verdict, "clean")
	})

	it("keeps a verdict the model did give, and ignores one it made up", () => {
		assert.equal(
			normalizePrReviewSubmission({ verdict: "not_applicable" }).report.verdict,
			"not_applicable",
		)
		assert.equal(
			normalizePrReviewSubmission({
				verdict: "looks fine",
				findings: [
					{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "critical", title: "x" },
				],
			}).report.verdict,
			"issues",
		)
	})

	it("forces issues when the model calls a warned diff clean", () => {
		const { report } = normalizePrReviewSubmission({
			verdict: "clean",
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "warn", title: "gap" }],
		})
		assert.equal(report.verdict, "issues")
	})

	it("does not call notes alone an issue", () => {
		const { report } = normalizePrReviewSubmission({
			verdict: "issues",
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "info", title: "nicety" }],
		})
		assert.equal(report.verdict, "clean")
	})

	it("falls back to warn for a severity outside the audit's three", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 1, severity: "medium", title: "x" }],
		})
		assert.equal(report.findings[0]!.severity, "warn")
	})

	it("ignores an end line at or before the start line", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [{ path: "src/a.ts", checkId: "SPAN-01", line: 10, endLine: 10, title: "same" }],
		})
		assert.equal(report.findings[0]!.endLine, undefined)
	})

	it("records which top-level keys the model filled", () => {
		const { filled } = normalizePrReviewSubmission({ summary: "s", coverage: [] })
		assert.deepEqual([...filled].sort(), ["coverage", "summary"])
	})

	it("keeps coverage rows that name a unit and drops the rest", () => {
		const { report } = normalizePrReviewSubmission({
			coverage: [
				{
					unit: "POST /orders",
					kind: "entrypoint",
					instrumented: true,
					evidence: "withSpan on line 40",
				},
				{ kind: "entrypoint" },
			],
		})
		assert.equal(report.coverage.length, 1)
		assert.equal(report.coverage[0]!.unit, "POST /orders")
		assert.equal(report.coverage[0]!.instrumented, true)
	})
})

describe("scorePrReview", () => {
	const withFindings = (severities: ReadonlyArray<string>) =>
		normalizePrReviewSubmission({
			findings: severities.map((severity, line) => ({
				path: "a.ts",
				line: line + 1,
				checkId: "SPAN-01",
				severity,
				title: "x",
			})),
		}).report

	it("is 100 with nothing found", () => {
		assert.deepEqual(scorePrReview(withFindings([])), { score: 100, grade: "excellent" })
	})

	it("takes a fixed penalty per finding, by severity", () => {
		assert.equal(scorePrReview(withFindings(["critical"])).score, 75)
		assert.equal(scorePrReview(withFindings(["warn", "warn"])).score, 80)
		assert.equal(scorePrReview(withFindings(["info"])).score, 98)
	})

	it("grades the score and never goes below zero", () => {
		assert.equal(scorePrReview(withFindings(["info"])).grade, "excellent")
		// 90 is the arithmetic, but a warn is a gap and a gap is never excellent.
		assert.equal(scorePrReview(withFindings(["warn"])).grade, "good")
		assert.equal(scorePrReview(withFindings(["critical"])).grade, "good")
		assert.equal(scorePrReview(withFindings(["critical", "critical"])).grade, "needs work")
		assert.deepEqual(scorePrReview(withFindings(Array(6).fill("critical"))), { score: 0, grade: "poor" })
	})
})

describe("mentions", () => {
	it("recognises @maple and the App's login, not look-alikes", () => {
		assert.isTrue(mentionsReviewer("@maple why?"))
		assert.isTrue(mentionsReviewer("thanks @MapleLabsApp."))
		assert.isFalse(mentionsReviewer("@maple-dev please"))
		assert.isFalse(mentionsReviewer("@maplefoo"))
		assert.isFalse(mentionsReviewer("mail me at x@maple.dev"))
		// A quote-reply or a code sample is not a new request.
		assert.isFalse(mentionsReviewer("> @maple fix the null check\n\nthanks"))
		assert.isFalse(mentionsReviewer("```\n@maple fix\n```"))
	})

	it("reads the command from the first word after the mention", () => {
		assert.deepEqual(parseReplyCommand("@maple review"), { command: "review", text: "@maple review" })
		assert.equal(parseReplyCommand("hey @maple fix the null check").command, "fix")
		assert.equal(parseReplyCommand("@maple why a lock here?").command, "ask")
		// A quoted fix request answered with a question is a question.
		assert.equal(parseReplyCommand("> @maple fix it\n\n@maple why?").command, "ask")
		assert.equal(parseReplyCommand("@maple fixture question").command, "ask")
	})

	it("recognises the install's own App login and reads its command", () => {
		const mention = reviewerMention("maple-review-bot")
		assert.equal(mention, "@maple-review-bot")
		assert.equal(reviewerMention(undefined), "@maple")
		assert.equal(reviewerMention(" "), "@maple")
		assert.isTrue(mentionsReviewer("@maple-review-bot why?", mention))
		assert.isFalse(mentionsReviewer("@maple-review-bot why?"))
		assert.isFalse(mentionsReviewer("@maple-review-botx why?", mention))
		assert.isTrue(mentionsReviewer("@maple why?", mention))
		assert.equal(parseReplyCommand("@maple-review-bot fix it", mention).command, "fix")
		assert.equal(parseReplyCommand("hey @Maple-Review-Bot review", mention).command, "review")
	})
})

describe("lenient numbers and booleans", () => {
	it("reads quoted lines and booleans instead of failing the run", () => {
		const { report } = normalizePrReviewSubmission({
			findings: [{ path: "a.ts", line: "12", endLine: "14", title: "x" }],
			coverage: [{ unit: "GET /x", instrumented: "true" }],
		})
		assert.equal(report.findings[0]!.line, 12)
		assert.equal(report.findings[0]!.endLine, 14)
		assert.isTrue(report.coverage[0]!.instrumented)
		assert.lengthOf(
			normalizePrReviewSubmission({ findings: [{ path: "a.ts", line: "x" }] }).report.findings,
			0,
		)
	})
})

describe("confidencePrReview", () => {
	const finding = (
		severity: "critical" | "warn" | "info",
		category: "correctness" | "security" | "performance" | "tests" = "correctness",
	) => ({
		path: "a.ts",
		line: 1,
		category,
		severity,
		title: "t",
		body: "b",
	})
	const reportWith = (
		findings: ReadonlyArray<ReturnType<typeof finding>>,
		extra: {
			readonly confidence?: number
			readonly tests?: "covered" | "partial" | "missing" | "not_needed"
			readonly risk?: "low" | "medium" | "high"
			readonly verdict?: "clean" | "issues" | "not_applicable"
			readonly unobservable?: boolean
			readonly unreviewed?: ReadonlyArray<string>
		} = {},
	) =>
		new PrReviewReport({
			verdict: extra.verdict ?? "clean",
			summary: "s",
			coverage:
				extra.unobservable === true
					? [{ unit: "cron", kind: "background", instrumented: false, evidence: "no span" }]
					: [],
			findings,
			...(extra.tests === undefined ? undefined : { tests: extra.tests }),
			...(extra.risk === undefined ? undefined : { risk: extra.risk }),
			...(extra.unreviewed === undefined ? undefined : { unreviewed: extra.unreviewed }),
			...(extra.confidence === undefined
				? undefined
				: { confidence: extra.confidence, confidenceReason: "why" }),
		})
	const score = (...args: Parameters<typeof reportWith>) =>
		confidencePrReview(reportWith(...args))?.confidence

	it("reads 10 for a clean change, whatever its notes or a medium risk", () => {
		assert.equal(score([], { tests: "covered", risk: "low" }), 10)
		assert.equal(score([], { tests: "covered", risk: "medium" }), 10)
		assert.equal(score([], { tests: "not_needed", risk: "medium" }), 10)
		assert.equal(score([finding("info"), finding("info")], { tests: "covered", risk: "medium" }), 10)
		assert.isUndefined(confidencePrReview(reportWith([], { verdict: "not_applicable" })))
	})

	it("takes whole points off for untested behavior, a high-risk area and unobservable work", () => {
		assert.equal(score([], { tests: "partial", risk: "medium" }), 9)
		assert.equal(score([], { tests: "covered", risk: "high" }), 9)
		assert.equal(score([], { tests: "missing", risk: "low" }), 8)
		assert.equal(score([], { tests: "covered", risk: "low", unobservable: true }), 9)
		assert.equal(score([], { tests: "missing", risk: "high", unobservable: true }), 6)
	})

	// The same findings cost the same, so a note never decides whether a warning reads 7 or 8.
	it("takes one point per warning and holds a test or observability warning at 8", () => {
		const gap = finding("warn", "tests")
		assert.equal(score([gap], { tests: "covered", risk: "medium" }), 8)
		assert.equal(score([gap, finding("info")], { tests: "covered", risk: "medium" }), 8)
		assert.equal(score([gap], { tests: "partial", risk: "medium" }), 8)
		assert.equal(score([gap, gap], { tests: "partial", risk: "medium" }), 7)
		assert.equal(score([gap], { tests: "missing", risk: "high" }), 6)
	})

	// "Likely safe to merge" beside a known bug is not true, whatever else the review found.
	it("holds an open correctness or performance warning at needs attention", () => {
		const bug = confidencePrReview(reportWith([finding("warn")], { tests: "covered", risk: "low" }))
		assert.equal(bug?.confidence, 6)
		assert.equal(bug?.reason, "Held at 6 because a correctness warning is open.")
		assert.equal(score([finding("warn", "performance")], { tests: "covered", risk: "low" }), 6)
		// Many ordinary defects still never read red without a danger.
		const many = Array.from({ length: 6 }, () => finding("warn"))
		assert.equal(score(many, { tests: "missing", risk: "high" }), 5)
	})

	// A re-review reads what changed since; around a fix nobody re-read it can miss more.
	it("holds fixes not yet re-checked against the whole diff at 8", () => {
		const clean = reportWith([], { tests: "covered", risk: "low" })
		assert.equal(confidencePrReview(clean)?.confidence, 10)
		const held = confidencePrReview(clean, [], false, 2)
		assert.equal(held?.confidence, 8)
		assert.equal(held?.cappedBy, "history")
		assert.equal(
			held?.reason,
			"Held at 8 because 2 fixes have not been re-checked against the whole diff yet.",
		)
		assert.include(held?.factors ?? [], "2 fixes not yet re-checked against the whole diff")
		assert.equal(
			confidencePrReview(clean, [], false, 1)?.reason,
			"Held at 8 because a fix has not been re-checked against the whole diff yet.",
		)
		// A tighter cap still binds.
		assert.equal(confidencePrReview(reportWith([finding("warn")]), [], false, 1)?.confidence, 6)
	})

	it("never reads below 5 on ordinary warnings and soft signals", () => {
		const many = Array.from({ length: 6 }, () => finding("warn"))
		const floored = confidencePrReview(
			reportWith(many, { tests: "missing", risk: "high", unobservable: true }),
		)
		assert.equal(floored?.confidence, 5)
		// The footer names the floor, so its points still explain the number.
		assert.equal(floored?.factors.at(-1), "floor 5")
		assert.equal(floored?.reason, "Kept at 5: ordinary warnings and soft signals never read below 5.")
		assert.notInclude(confidencePrReview(reportWith([finding("warn")]))?.factors ?? [], "floor 5")
		// Under a danger cap there is no floor to name, however far the points fall.
		const sunk = confidencePrReview(reportWith([finding("critical"), ...many], { tests: "missing" }))
		assert.equal(sunk?.confidence, 1)
		assert.notInclude(sunk?.factors.join(" ") ?? "", "floor")
	})

	it("caps on a critical, a security warning or an early end, and says why", () => {
		const one = confidencePrReview(reportWith([finding("critical")], { tests: "covered", risk: "low" }))
		assert.equal(one?.confidence, 4)
		assert.equal(one?.reason, "Held at 4 because a critical finding is open.")
		assert.equal(one?.cappedBy, "critical")
		assert.equal(
			confidencePrReview(reportWith([finding("critical")]), [finding("critical")])?.confidence,
			2,
		)
		assert.equal(score([finding("warn", "security")]), 4)
		assert.equal(confidencePrReview(reportWith([]), [], true)?.confidence, 6)
		// Below a danger cap there is no floor: a critical with missing tests reads red.
		assert.equal(score([finding("critical")], { tests: "missing", risk: "high" }), 4)
		assert.equal(score([finding("critical"), finding("warn"), finding("warn")], { tests: "missing" }), 3)
	})

	// A pass that skipped files cannot vouch for them, whatever it found in the rest.
	it("caps on reviewed files left unread", () => {
		const one = confidencePrReview(reportWith([], { unreviewed: ["src/b.ts"] }))
		assert.equal(one?.confidence, 8)
		assert.equal(one?.cappedBy, "unread")
		assert.equal(one?.reason, "Held at 8 because 1 reviewed file was not read.")
		assert.include(one?.factors ?? [], "1 file not read")
		const many = confidencePrReview(reportWith([], { unreviewed: ["a.ts", "b.ts", "c.ts"] }))
		assert.equal(many?.confidence, 6)
		assert.equal(many?.reason, "Held at 6 because 3 reviewed files were not read.")
		// A tighter cap still says what binds.
		assert.equal(
			confidencePrReview(reportWith([finding("critical")], { unreviewed: ["a.ts"] }))?.cappedBy,
			"critical",
		)
	})

	it("ignores the reviewer's own number and keeps its reason", () => {
		assert.equal(score([], { tests: "covered", confidence: 3 }), 10)
		assert.equal(score([finding("warn", "tests")], { tests: "partial", confidence: 10 }), 8)
		assert.equal(confidencePrReview(reportWith([], { confidence: 3 }))?.reason, "why")
	})

	it("keeps a known test or risk signal and drops an unknown one", () => {
		const kept = normalizePrReviewSubmission({ summary: "s", tests: " Partial ", risk: "HIGH" }).report
		assert.equal(kept.tests, "partial")
		assert.equal(kept.risk, "high")
		const dropped = normalizePrReviewSubmission({ summary: "s", tests: "some", risk: null }).report
		assert.isUndefined(dropped.tests)
		assert.isUndefined(dropped.risk)
	})

	it("lists what went into the number", () => {
		assert.deepEqual(
			confidencePrReview(
				reportWith([finding("warn", "tests")], {
					tests: "not_needed",
					risk: "medium",
					unobservable: true,
				}),
			)?.factors,
			["1 warning −1", "tests not needed", "risk medium", "0/1 new units observable −1"],
		)
	})

	it("normalizes a quoted or out-of-range number from the model", () => {
		const high = normalizePrReviewSubmission({ verdict: "clean", summary: "s", confidence: "14" }).report
		assert.equal(high.confidence, 10)
		const low = normalizePrReviewSubmission({ verdict: "clean", summary: "s", confidence: 0.2 }).report
		assert.equal(low.confidence, 1)
	})
})

describe("normalizePrReviewFinding", () => {
	it("posts one finding as submit_review would, and refuses one it cannot anchor", () => {
		assert.equal(normalizePrReviewFinding({ path: "src/a.ts", line: "12", title: "Bug" })?.line, 12)
		assert.isUndefined(normalizePrReviewFinding({ path: "src/a.ts", line: 0 }))
		assert.isUndefined(normalizePrReviewFinding({ path: "src/a.ts", line: 3, category: "observability" }))
	})

	it("keeps a privacy check id on a security finding, and no other id outside observability", () => {
		const checkIdOf = (category: string, checkId: string) =>
			normalizePrReviewFinding({ path: "src/a.ts", line: 3, category, checkId })?.checkId
		assert.equal(checkIdOf("security", "pii-01"), "PII-01")
		assert.isUndefined(checkIdOf("security", "SPAN-01"))
		assert.isUndefined(checkIdOf("correctness", "PII-01"))
		assert.equal(checkIdOf("observability", "SPAN-01"), "SPAN-01")
		const uncategorized = normalizePrReviewFinding({ path: "src/a.ts", line: 3, checkId: "PII-01" })
		assert.equal(uncategorized?.category, "security")
	})
})

describe("prReviewFailureReason", () => {
	it("reads the reason an error starts with, and nothing from older errors", () => {
		assert.equal(prReviewFailureReason("time_limit: It ran out of time."), "time_limit")
		assert.isUndefined(prReviewFailureReason("no_review: the agent ended its pass"))
		assert.isUndefined(prReviewFailureReason(null))
	})
})
