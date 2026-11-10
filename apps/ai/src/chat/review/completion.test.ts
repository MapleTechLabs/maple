/**
 * `submit_review` and `record_finding`: what a review's unattended pass files, what it is refused
 * once, and what the turn files itself when no report lands.
 */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import { MAPLE_NATIVE_SESSION_ID_ATTR } from "@maple/domain/gen-ai"
import { ChatConnectorId, ExternalUserId } from "@maple/primitives"
import { Effect, Result, Schema, Array as Arr } from "effect"
import { assert, describe, it } from "vitest"
import {
	PrReviewFinding,
	type PrReviewFindingSubmission,
	type PrReviewSubmission,
	type SubmitPrReviewRequest,
} from "@maple/domain/http"
import { type CompletionRun, SUBMIT_REVIEW } from "../completion"
import { makeRunUsage } from "../usage"
import { type ChildFindings, makeChildFindings } from "./child-findings"
import { RECORD_FINDING, reviewCompletion, savedFindingsRequest, type SubmitReview } from "./completion"
import type { ReviewCoverage } from "./coverage"
import { makeReviewLedger, type ReviewLedger } from "./ledger"

const CONNECTOR_ORIGIN: ChatTurnOrigin = {
	kind: "connector",
	connectorId: Schema.decodeSync(ChatConnectorId)("testchat"),
	workspaceId: "w1",
	externalUserId: Schema.decodeSync(ExternalUserId)("u-1"),
	displayName: "Ada",
}

const SESSION_ATTRIBUTES = { [MAPLE_NATIVE_SESSION_ID_ATTR]: "session-1" }

const runFor = (partial = false): CompletionRun => ({
	turnId: "msg-1",
	usage: makeRunUsage(),
	modelName: "@cf/test/model",
	partial,
	sessionAttributes: SESSION_ATTRIBUTES,
})

/** Nothing unread and no whole-diff read: a pass whose coverage nobody is checking. */
const UNWATCHED: ReviewCoverage = { observe: () => {}, unread: () => [], wholeDiff: () => false }

/** The review completion an unattended pass is handed, with the turn's state defaulted. */
const reviewFor = (
	submit: SubmitReview,
	options: {
		readonly partial?: boolean
		readonly coverage?: ReviewCoverage
		readonly ledger?: ReviewLedger
		readonly childFindings?: ChildFindings
	} = {},
) => {
	const completion = reviewCompletion(
		{ kind: "autonomous" },
		{
			coverage: options.coverage ?? UNWATCHED,
			ledger: options.ledger ?? makeReviewLedger(),
			childFindings: options.childFindings ?? makeChildFindings(),
		},
		submit,
	)
	assert.isDefined(completion)
	return completion(runFor(options.partial))
}

describe("reviewCompletion", () => {
	const submitReview: SubmitReview = () => Effect.undefined
	const offered = (origin: ChatTurnOrigin) =>
		reviewCompletion(
			origin,
			{ coverage: UNWATCHED, ledger: makeReviewLedger(), childFindings: makeChildFindings() },
			submitReview,
		)?.(runFor())

	it("gives the review's unattended pass the review tool", () => {
		assert.equal(offered({ kind: "autonomous" })?.tool, SUBMIT_REVIEW)
	})

	/**
	 * A follow-up in the review's tab would file a second report onto a settled row, which is
	 * dropped while the tool reports success.
	 */
	it("gives a person's follow-up in the review session no review tool", () => {
		assert.isUndefined(offered({ kind: "app" }))
		assert.isUndefined(offered(CONNECTOR_ORIGIN))
	})

	describe("with files unread", () => {
		const coverage = (unread: ReadonlyArray<string>, wholeDiff = true): ReviewCoverage => ({
			observe: () => {},
			unread: () => unread,
			wholeDiff: () => wholeDiff,
		})
		const recording = () => {
			const filed: Array<unknown> = []
			const submit: SubmitReview = (request) => Effect.sync(() => filed.push(request))
			return { filed, submit }
		}
		const submitWith = (
			submit: SubmitReview,
			unread: ReadonlyArray<string>,
			partial = false,
			wholeDiff = true,
		) => {
			const completion = reviewFor(submit, { partial, coverage: coverage(unread, wholeDiff) })
			assert.isDefined(completion)
			return {
				completion: completion,
				call: (submission: PrReviewSubmission) =>
					Effect.runPromise(Effect.result(completion.handlers[SUBMIT_REVIEW](submission))),
			}
		}
		const CLEAN: PrReviewSubmission = { verdict: "clean", summary: "Adds a retry to the order client." }

		it("refuses the first submission, naming the files, and records the second", async () => {
			const { filed, submit } = recording()
			const { completion, call } = submitWith(submit, ["src/b.ts"])

			const first = await call(CLEAN)
			assert.isTrue(Result.isFailure(first))
			assert.include(Result.isFailure(first) ? first.failure.message : "", "src/b.ts")
			assert.lengthOf(filed, 0)
			assert.isFalse(completion.submitted())

			const second = await call(CLEAN)
			assert.isTrue(Result.isSuccess(second))
			assert.lengthOf(filed, 1)
			assert.isTrue(completion.submitted())
		})

		it("records straight away when every reviewed file was read", async () => {
			const { filed, submit } = recording()
			assert.isTrue(Result.isSuccess(await submitWith(submit, []).call(CLEAN)))
			assert.lengthOf(filed, 1)
		})

		// Only a pass that read every file re-checks the fixes since the last one; the service lifts its cap on it.
		it("marks the report a whole-diff read only when every file was due and read", async () => {
			const filedWholeDiff = async (
				unread: ReadonlyArray<string>,
				partial: boolean,
				wholeDiff: boolean,
				submission: PrReviewSubmission = CLEAN,
			) => {
				const filed: Array<SubmitPrReviewRequest> = []
				const { call } = submitWith(
					(request) => Effect.sync(() => filed.push(request)),
					unread,
					partial,
					wholeDiff,
				)
				// Unread files are refused once; the second call records.
				await call(submission)
				if (filed.length === 0) await call(submission)
				assert.lengthOf(filed, 1)
				return filed[0]?.report.wholeDiff
			}
			assert.isTrue(await filedWholeDiff([], false, true))
			assert.isUndefined(await filedWholeDiff([], false, false))
			assert.isUndefined(await filedWholeDiff(["src/b.ts"], false, true))
			assert.isUndefined(await filedWholeDiff([], true, true))
			assert.isUndefined(
				await filedWholeDiff(["src/b.ts"], false, true, {
					verdict: "not_applicable",
					summary: "Only docs changed.",
				}),
			)
		})

		it("never holds a close-out or a not_applicable verdict", async () => {
			const closeOut = recording()
			assert.isTrue(Result.isSuccess(await submitWith(closeOut.submit, ["src/b.ts"], true).call(CLEAN)))
			assert.lengthOf(closeOut.filed, 1)

			const notApplicable = recording()
			const result = await submitWith(notApplicable.submit, ["src/b.ts"]).call({
				verdict: "not_applicable",
				summary: "Only docs changed.",
			})
			assert.isTrue(Result.isSuccess(result))
			assert.lengthOf(notApplicable.filed, 1)
		})
	})

	describe("with a child reviewer's warning", () => {
		const CHILD_ANSWER =
			"src/capture.ts:213 | warn | correctness | Queue can finish before the forced capture starts | " +
			"A slow forced start lets the consumer ack the old session | Enqueue after the start returns | -\n" +
			"src/capture.ts:40 | info | maintainability | Constant duplicated | Drifts | Share it | -"
		const submitWith = (partial = false) => {
			const filed: Array<SubmitPrReviewRequest> = []
			const children = makeChildFindings()
			children.observe(CHILD_ANSWER)
			const completion = reviewFor((request) => Effect.sync(() => filed.push(request)), {
				partial,
				childFindings: children,
			})
			const call = (submission: PrReviewSubmission) =>
				Effect.runPromise(Effect.result(completion.handlers[SUBMIT_REVIEW](submission)))
			return { filed, call }
		}
		const CLEAN: PrReviewSubmission = { verdict: "clean", summary: "Moves capture onto a queue." }

		it("refuses a review that drops it, then files it as the child reported it", async () => {
			const { filed, call } = submitWith()

			const first = await call(CLEAN)
			assert.isTrue(Result.isFailure(first))
			assert.include(Result.isFailure(first) ? first.failure.message : "", "src/capture.ts:213")
			assert.notInclude(Result.isFailure(first) ? first.failure.message : "", "src/capture.ts:40")
			assert.lengthOf(filed, 0)

			assert.isTrue(Result.isSuccess(await call(CLEAN)))
			assert.deepStrictEqual(
				Arr.map(Arr.getUnsafe(filed, 0).report.findings, (finding) => [
					finding.path,
					finding.line,
					finding.severity,
				]),
				[["src/capture.ts", 213, "warn"]],
			)
			assert.equal(Arr.getUnsafe(filed, 0).report.verdict, "issues")
		})

		it("files a child's observability warning without an audit id as a correctness finding", async () => {
			const filed: Array<SubmitPrReviewRequest> = []
			const children = makeChildFindings()
			children.observe(
				"src/queue.ts:7 | warn | observability | Consumer has no span | Untraced | Wrap it | -",
			)
			const completion = reviewFor((request) => Effect.sync(() => filed.push(request)), {
				childFindings: children,
			})
			const call = () => Effect.runPromise(Effect.result(completion.handlers[SUBMIT_REVIEW](CLEAN)))
			assert.isTrue(Result.isFailure(await call()))
			assert.isTrue(Result.isSuccess(await call()))
			assert.deepStrictEqual(
				Arr.map(Arr.getUnsafe(filed, 0).report.findings, (finding) => [
					finding.path,
					finding.category,
				]),
				[["src/queue.ts", "correctness"]],
			)
		})

		it("files it straight away in a close-out, which is never refused", async () => {
			const { filed, call } = submitWith(true)
			assert.isTrue(Result.isSuccess(await call(CLEAN)))
			assert.deepStrictEqual(
				Arr.map(Arr.getUnsafe(filed, 0).report.findings, (finding) => [finding.path, finding.line]),
				[["src/capture.ts", 213]],
			)
		})

		it("accepts a dismissal that spells the path with a leading ./", async () => {
			const { filed, call } = submitWith()
			const result = await call({
				...CLEAN,
				childDismissals: [
					{ path: "./src/capture.ts", line: 213, reason: "The start resets the session." },
				],
			})
			assert.isTrue(Result.isSuccess(result))
			assert.lengthOf(Arr.getUnsafe(filed, 0).report.findings, 0)
		})

		it("counts a finding saved and repeated in the submission once", async () => {
			const children = makeChildFindings()
			children.observe(
				Arr.join(
					[
						"src/capture.ts:213 | warn | correctness | Queue acks early | Why | Fix | -",
						"src/capture.ts:216 | warn | security | Secret in a log | Why | Fix | -",
					],
					"\n",
				),
			)
			const completion = reviewFor(() => Effect.void, { childFindings: children })
			const finding = {
				path: "src/capture.ts",
				line: 214,
				severity: "warn",
				category: "correctness",
				title: "Queue acks before the forced capture starts",
				body: "Why",
			}
			await Effect.runPromise(completion.handlers[RECORD_FINDING](finding))
			const result = await Effect.runPromise(
				Effect.result(completion.handlers[SUBMIT_REVIEW]({ ...CLEAN, findings: [finding] })),
			)
			assert.isTrue(Result.isFailure(result))
			assert.include(Result.isFailure(result) ? result.failure.message : "", "src/capture.ts:216")
		})

		it("records a review that dismisses it with a reason", async () => {
			const { filed, call } = submitWith()
			const result = await call({
				...CLEAN,
				childDismissals: [
					{
						path: "src/capture.ts",
						line: 213,
						reason: "The forced start resets the session synchronously.",
					},
				],
			})
			assert.isTrue(Result.isSuccess(result))
			assert.lengthOf(Arr.getUnsafe(filed, 0).report.findings, 0)
		})

		it("records a review that files it near the child's line", async () => {
			const { filed, call } = submitWith()
			const result = await call({
				...CLEAN,
				findings: [
					{
						path: "src/capture.ts",
						line: 210,
						severity: "warn",
						category: "correctness",
						title: "Race",
						body: "b",
					},
				],
			})
			assert.isTrue(Result.isSuccess(result))
			assert.lengthOf(Arr.getUnsafe(filed, 0).report.findings, 1)
		})
	})
})

describe("record_finding", () => {
	const RETRY: PrReviewFindingSubmission = {
		path: "src/orders.ts",
		line: 42,
		category: "correctness",
		severity: "warn",
		title: "`retryFetch` re-sends POSTs that are not idempotent",
		body: "A timeout after the server committed charges the order twice.",
	}
	const setup = (unread: ReadonlyArray<string> = [], partial = false) => {
		const filed: Array<SubmitPrReviewRequest> = []
		const ledger = makeReviewLedger()
		const completion = reviewFor((request) => Effect.sync(() => filed.push(request)), {
			partial,
			coverage: { observe: () => {}, unread: () => unread, wholeDiff: () => true },
			ledger,
		})
		assert.isDefined(completion)
		const handlers = completion.handlers
		return {
			filed,
			ledger,
			save: (finding: PrReviewFindingSubmission) =>
				Effect.runPromise(Effect.result(handlers[RECORD_FINDING](finding))),
			submit: (submission: PrReviewSubmission) =>
				Effect.runPromise(Effect.result(handlers[SUBMIT_REVIEW](submission))),
		}
	}

	// An inline comment the author reads in ten seconds: the body says what breaks, the fix is below it.
	it("refuses an essay-length finding with what to cut, then saves the rewrite", async () => {
		const { ledger, save } = setup()
		const essay = {
			...RETRY,
			body: Arr.join(
				Array.from({ length: 70 }, (_, i) => `word${i}`),
				" ",
			),
		}
		const refused = await save(essay)
		assert.isTrue(Result.isFailure(refused))
		const message = Result.isFailure(refused) ? refused.failure.message : ""
		assert.include(message, "src/orders.ts:42")
		assert.include(message, "its body is 70 words, over 60")
		assert.lengthOf(ledger.findings(), 0)
		assert.isTrue(Result.isSuccess(await save(RETRY)))
		assert.lengthOf(ledger.findings(), 1)
	})

	it("stops refusing length after a few tries, so a finding is never lost to it", async () => {
		const { ledger, save } = setup()
		const essay = (line: number) => ({
			...RETRY,
			line,
			title: `finding ${line}`,
			suggestion: Arr.join(
				Array.from({ length: 40 }, () => "fix"),
				" ",
			),
		})
		const outcomes = []
		for (const line of [1, 2, 3, 4, 5]) outcomes.push(Result.isSuccess(await save(essay(line))))
		assert.deepStrictEqual(outcomes, [false, false, false, false, true])
		assert.lengthOf(ledger.findings(), 1)
	})

	// A close-out is the pass's last call: refusing it would lose the review.
	it("never refuses a close-out for length", async () => {
		const { filed, submit } = setup([], true)
		const result = await submit({
			verdict: "issues",
			summary: "Adds a retry to the order client.",
			findings: [
				{
					...RETRY,
					body: Arr.join(
						Array.from({ length: 61 }, () => "w"),
						" ",
					),
				},
			],
		})
		assert.isTrue(Result.isSuccess(result))
		assert.lengthOf(Arr.getUnsafe(filed, 0).report.findings, 1)
	})

	it("refuses a submission with an overlong finding once, then records it as given", async () => {
		const { filed, submit } = setup()
		const submission: PrReviewSubmission = {
			verdict: "issues",
			summary: "Adds a retry to the order client.",
			findings: [
				{
					...RETRY,
					body: Arr.join(
						Array.from({ length: 61 }, () => "w"),
						" ",
					),
				},
			],
		}
		const first = await submit(submission)
		assert.isTrue(Result.isFailure(first))
		assert.include(Result.isFailure(first) ? first.failure.message : "", "over 60")
		assert.isTrue(Result.isSuccess(await submit(submission)))
		assert.lengthOf(Arr.getUnsafe(filed, 0).report.findings, 1)
	})

	it("saves a finding and adds it to the submitted report, dropping a restatement", async () => {
		const { filed, ledger, save, submit } = setup()
		assert.isTrue(Result.isSuccess(await save(RETRY)))
		assert.lengthOf(ledger.findings(), 1)

		const result = await submit({
			verdict: "clean",
			summary: "Adds a retry to the order client.",
			findings: [
				{ ...RETRY, line: 43, title: "`retryFetch` re-sends POSTs which are not idempotent" },
				{ path: "src/orders.ts", line: 90, severity: "info", title: "Unused `backoff` import" },
			],
		})
		assert.isTrue(Result.isSuccess(result))
		const report = Arr.getUnsafe(filed, 0).report
		assert.deepStrictEqual(
			Arr.map(report.findings, (finding) => finding.line),
			[42, 90],
		)
		// A saved warn makes the review one with issues, whatever the submission called it.
		assert.equal(report.verdict, "issues")
	})

	it("answers a repeat without saving it twice", async () => {
		const { ledger, save } = setup()
		await save(RETRY)
		const again = await save({ ...RETRY, line: 44 })
		assert.isTrue(Result.isSuccess(again))
		assert.include(Result.isSuccess(again) ? String(again.success) : "", "restates")
		assert.lengthOf(ledger.findings(), 1)
	})

	it("refuses a finding it could not post", async () => {
		const { ledger, save } = setup()
		const result = await save({ ...RETRY, line: null })
		assert.isTrue(Result.isFailure(result))
		assert.lengthOf(ledger.findings(), 0)
	})

	it("names the reviewed files a close-out never read on its report", async () => {
		const { filed, submit } = setup(["src/b.ts", "src/c.ts"], true)
		assert.isTrue(Result.isSuccess(await submit({ verdict: "clean", summary: "Partial." })))
		assert.deepStrictEqual(Arr.getUnsafe(filed, 0).report.unreviewed, ["src/b.ts", "src/c.ts"])
	})
})

describe("savedFindingsRequest", () => {
	it("files saved findings as a partial with the unread files", () => {
		const request = savedFindingsRequest({
			findings: [
				new PrReviewFinding({
					path: "src/a.ts",
					line: 3,
					category: "security",
					severity: "critical",
					title: "Tenant filter missing from `listKeys`",
					body: "",
				}),
			],
			unreviewed: ["src/b.ts"],
			modelName: "@cf/test/model",
			usage: makeRunUsage(),
		})
		assert.isTrue(request.partial)
		assert.equal(request.report.verdict, "issues")
		assert.deepStrictEqual(request.report.unreviewed, ["src/b.ts"])
		assert.lengthOf(request.report.findings, 1)
	})
})
