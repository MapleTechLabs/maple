/**
 * `buildDiagnosisCompletion` — the one value an investigation turn answers through.
 *
 * The tool and whether the run is an autonomous pass travel together: the turn runner closes a
 * pass out itself when `submitted()` stays false, and must never do that to a human follow-up.
 */
import { type ChatTurnOrigin, prReviewSessionId } from "@maple/domain/chat-session"
import { MAPLE_NATIVE_SESSION_ID_ATTR } from "@maple/domain/gen-ai"
import { ChatConnectorId, ExternalUserId, OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Result, Schema } from "effect"
import { assert, describe, it } from "vitest"
import {
	buildDiagnosisCompletion,
	buildReviewCompletion,
	makeRunUsage,
	RECORD_FINDING,
	savedFindingsRequest,
	SUBMIT_DIAGNOSIS,
	SUBMIT_REVIEW,
	type SubmitDiagnosis,
	type SubmitReview,
} from "./tools"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { makeRecordingTracer } from "@maple/backend/testing/recording-tracer"
import {
	PrReviewFinding,
	type PrReviewFindingSubmission,
	type PrReviewSubmission,
	type SubmitPrReviewRequest,
} from "@maple/domain/http"
import type { ReviewCoverage } from "./review-coverage"
import { makeChildFindings } from "./review-child-findings"
import { makeReviewLedger } from "./review-ledger"

const orgId = Schema.decodeSync(OrgId)("org_test")
const human = Schema.decodeSync(UserId)("user_test")

const CONNECTOR_ORIGIN: ChatTurnOrigin = {
	kind: "connector",
	connectorId: Schema.decodeSync(ChatConnectorId)("testchat"),
	workspaceId: "w1",
	externalUserId: Schema.decodeSync(ExternalUserId)("u-1"),
	displayName: "Ada",
}

const tenantFor = (userId: UserId): TenantContext => ({
	orgId,
	userId,
	roles: [],
	authMode: "self_hosted",
})

const MODEL_NAME = "@cf/test/model"

const INVESTIGATION_SESSION = `${orgId}:inv-00000000-0000-0000-0000-000000000000`

const submitDiagnosis: SubmitDiagnosis = () => Effect.succeed(undefined)

const SESSION_ATTRIBUTES = { [MAPLE_NATIVE_SESSION_ID_ATTR]: "session-1" }

const build = (sessionId: string, origin: ChatTurnOrigin) =>
	buildDiagnosisCompletion(
		sessionId,
		"msg-1",
		tenantFor(human),
		origin,
		submitDiagnosis,
		makeRunUsage(),
		MODEL_NAME,
		false,
		SESSION_ATTRIBUTES,
	)

const sampleSubmission = () => ({
	summary: "Checkout latency doubled after the 14:00 deploy.",
	suspectedCause: "Regression in the payments client connection pool",
	severityAssessment: "high",
	affectedScope: "checkout-api, p95 across all regions",
	evidence: [{ traceIds: ["abc123def456"], note: "Pool saturation in the failing traces" }],
	suggestedActions: ["Roll back the 14:00 deploy"],
	confidence: "high",
})

describe("buildDiagnosisCompletion", () => {
	it("gives an ordinary conversation no completion at all", () => {
		assert.isUndefined(build(`${orgId}:tab`, { kind: "app" }))
	})

	it("gives a session whose inv- suffix is not an id no completion", () => {
		assert.isUndefined(build(`${orgId}:inv-not-a-uuid`, { kind: "app" }))
	})

	it("marks the autonomous investigation turn as one the runner must close out", () => {
		const completion = build(INVESTIGATION_SESSION, { kind: "autonomous" })

		assert.isDefined(completion?.toolkit)
		assert.isTrue(completion?.autonomous)
		assert.isFalse(completion?.submitted())
	})

	/**
	 * A human follow-up in the same session gets the same tool and is never closed out: it may file
	 * a superseding diagnosis, but "what did you mean by the pool?" must be answerable in prose.
	 */
	it("offers the same tool to a human follow-up without treating it as a pass", () => {
		const completion = build(INVESTIGATION_SESSION, { kind: "app" })

		assert.isDefined(completion?.toolkit)
		assert.isFalse(completion?.autonomous)
	})

	/**
	 * This tool is merged into the run's toolkit *outside* the permission ruleset, so the approval
	 * gate does not reach it — and it writes: a report row, and the investigation's status. A
	 * channel is not where a diagnosis gets settled, so a connector origin is refused here by name.
	 */
	it("gives a connector turn no diagnosis tool, even on an investigation session", () => {
		assert.isUndefined(build(INVESTIGATION_SESSION, CONNECTOR_ORIGIN))
	})

	/**
	 * The arguments ARE the report, and the engine's `execute_tool` span carries no content of its
	 * own: registered without `toolHandlersWithContent`, every diagnosis in Agent Sessions rendered
	 * as a tool call with no arguments and no result.
	 */
	it("records the report and the result on the tool's span", async () => {
		const completion = build(INVESTIGATION_SESSION, { kind: "autonomous" })
		assert.isDefined(completion)
		const { spans, tracer } = makeRecordingTracer()

		await Effect.runPromise(
			completion!.handlers[SUBMIT_DIAGNOSIS](sampleSubmission()).pipe(
				Effect.withSpan(`execute_tool ${SUBMIT_DIAGNOSIS}`),
				Effect.withTracer(tracer),
			),
		)

		const attributes = spans[0]?.attributes
		assert.include(String(attributes?.get("gen_ai.tool.call.arguments")), "Checkout latency doubled")
		assert.include(String(attributes?.get("gen_ai.tool.call.result")), "Diagnosis recorded.")
		assert.include(String(attributes?.get("gen_ai.tool.description")), "structured diagnosis")
		// The same session identity every other tool span carries, so the call files under its turn.
		assert.equal(attributes?.get(MAPLE_NATIVE_SESSION_ID_ATTR), "session-1")
	})
})

describe("buildReviewCompletion", () => {
	const REVIEW_SESSION = prReviewSessionId(orgId, "7f1d3c2e-9a4b-4c8d-8e2f-1a2b3c4d5e6f")
	const submitReview: SubmitReview = () => Effect.succeed(undefined)
	const buildReview = (sessionId: string, origin: ChatTurnOrigin) =>
		buildReviewCompletion(sessionId, tenantFor(human), origin, submitReview, makeRunUsage(), MODEL_NAME)

	it("gives the review's unattended pass the review tool", () => {
		assert.equal(buildReview(REVIEW_SESSION, { kind: "autonomous" })?.tool, SUBMIT_REVIEW)
	})

	/**
	 * A follow-up in the review's tab would file a second report onto a settled row, which is
	 * dropped while the tool reports success.
	 */
	it("gives a person's follow-up in the review session no review tool", () => {
		assert.isUndefined(buildReview(REVIEW_SESSION, { kind: "app" }))
		assert.isUndefined(buildReview(REVIEW_SESSION, CONNECTOR_ORIGIN))
	})

	it("gives a session that is not a review no review tool", () => {
		assert.isUndefined(buildReview(INVESTIGATION_SESSION, { kind: "autonomous" }))
	})

	describe("with files unread", () => {
		const coverage = (unread: ReadonlyArray<string>, wholeDiff = true): ReviewCoverage => ({
			observe: () => {},
			unread: () => unread,
			wholeDiff: () => wholeDiff,
		})
		const recording = () => {
			const filed: Array<unknown> = []
			const submit: SubmitReview = (_org, _id, request) => Effect.sync(() => filed.push(request))
			return { filed, submit }
		}
		const submitWith = (
			submit: SubmitReview,
			unread: ReadonlyArray<string>,
			partial = false,
			wholeDiff = true,
		) => {
			const completion = buildReviewCompletion(
				REVIEW_SESSION,
				tenantFor(human),
				{ kind: "autonomous" },
				submit,
				makeRunUsage(),
				MODEL_NAME,
				partial,
				undefined,
				coverage(unread, wholeDiff),
			)
			assert.isDefined(completion)
			return {
				completion: completion!,
				call: (submission: PrReviewSubmission) =>
					Effect.runPromise(Effect.result(completion!.handlers[SUBMIT_REVIEW](submission))),
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
			) => {
				const filed: Array<SubmitPrReviewRequest> = []
				const { call } = submitWith(
					(_org, _id, request) => Effect.sync(() => filed.push(request)),
					unread,
					partial,
					wholeDiff,
				)
				// Unread files are refused once; the second call records.
				await call(CLEAN)
				if (filed.length === 0) await call(CLEAN)
				assert.lengthOf(filed, 1)
				return filed[0]?.report.wholeDiff
			}
			assert.isTrue(await filedWholeDiff([], false, true))
			assert.isUndefined(await filedWholeDiff([], false, false))
			assert.isUndefined(await filedWholeDiff(["src/b.ts"], false, true))
			assert.isUndefined(await filedWholeDiff([], true, true))
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
			const completion = buildReviewCompletion(
				REVIEW_SESSION,
				tenantFor(human),
				{ kind: "autonomous" },
				(_org, _id, request) => Effect.sync(() => filed.push(request)),
				makeRunUsage(),
				MODEL_NAME,
				partial,
				undefined,
				undefined,
				makeReviewLedger(),
				children,
			)!
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
				filed[0]!.report.findings.map((finding) => [finding.path, finding.line, finding.severity]),
				[["src/capture.ts", 213, "warn"]],
			)
			assert.equal(filed[0]!.report.verdict, "issues")
		})

		it("files a child's observability warning without an audit id as a correctness finding", async () => {
			const filed: Array<SubmitPrReviewRequest> = []
			const children = makeChildFindings()
			children.observe(
				"src/queue.ts:7 | warn | observability | Consumer has no span | Untraced | Wrap it | -",
			)
			const completion = buildReviewCompletion(
				REVIEW_SESSION,
				tenantFor(human),
				{ kind: "autonomous" },
				(_org, _id, request) => Effect.sync(() => filed.push(request)),
				makeRunUsage(),
				MODEL_NAME,
				false,
				undefined,
				undefined,
				makeReviewLedger(),
				children,
			)!
			const call = () => Effect.runPromise(Effect.result(completion.handlers[SUBMIT_REVIEW](CLEAN)))
			assert.isTrue(Result.isFailure(await call()))
			assert.isTrue(Result.isSuccess(await call()))
			assert.deepStrictEqual(
				filed[0]!.report.findings.map((finding) => [finding.path, finding.category]),
				[["src/queue.ts", "correctness"]],
			)
		})

		it("files it straight away in a close-out, which is never refused", async () => {
			const { filed, call } = submitWith(true)
			assert.isTrue(Result.isSuccess(await call(CLEAN)))
			assert.deepStrictEqual(
				filed[0]!.report.findings.map((finding) => [finding.path, finding.line]),
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
			assert.lengthOf(filed[0]!.report.findings, 0)
		})

		it("counts a finding saved and repeated in the submission once", async () => {
			const children = makeChildFindings()
			children.observe(
				[
					"src/capture.ts:213 | warn | correctness | Queue acks early | Why | Fix | -",
					"src/capture.ts:216 | warn | security | Secret in a log | Why | Fix | -",
				].join("\n"),
			)
			const completion = buildReviewCompletion(
				REVIEW_SESSION,
				tenantFor(human),
				{ kind: "autonomous" },
				() => Effect.void,
				makeRunUsage(),
				MODEL_NAME,
				false,
				undefined,
				undefined,
				makeReviewLedger(),
				children,
			)!
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
			assert.lengthOf(filed[0]!.report.findings, 0)
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
			assert.lengthOf(filed[0]!.report.findings, 1)
		})
	})
})

describe("record_finding", () => {
	const REVIEW_SESSION = prReviewSessionId(orgId, "7f1d3c2e-9a4b-4c8d-8e2f-1a2b3c4d5e6f")
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
		const completion = buildReviewCompletion(
			REVIEW_SESSION,
			tenantFor(human),
			{ kind: "autonomous" },
			(_org, _id, request) => Effect.sync(() => filed.push(request)),
			makeRunUsage(),
			MODEL_NAME,
			partial,
			undefined,
			{ observe: () => {}, unread: () => unread, wholeDiff: () => true },
			ledger,
		)
		assert.isDefined(completion)
		const handlers = completion!.handlers
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
		const essay = { ...RETRY, body: Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ") }
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
			suggestion: Array.from({ length: 40 }, () => "fix").join(" "),
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
			findings: [{ ...RETRY, body: Array.from({ length: 61 }, () => "w").join(" ") }],
		})
		assert.isTrue(Result.isSuccess(result))
		assert.lengthOf(filed[0]!.report.findings, 1)
	})

	it("refuses a submission with an overlong finding once, then records it as given", async () => {
		const { filed, submit } = setup()
		const submission: PrReviewSubmission = {
			verdict: "issues",
			summary: "Adds a retry to the order client.",
			findings: [{ ...RETRY, body: Array.from({ length: 61 }, () => "w").join(" ") }],
		}
		const first = await submit(submission)
		assert.isTrue(Result.isFailure(first))
		assert.include(Result.isFailure(first) ? first.failure.message : "", "over 60")
		assert.isTrue(Result.isSuccess(await submit(submission)))
		assert.lengthOf(filed[0]!.report.findings, 1)
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
		const report = filed[0]!.report
		assert.deepStrictEqual(
			report.findings.map((finding) => finding.line),
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
		assert.deepStrictEqual(filed[0]!.report.unreviewed, ["src/b.ts", "src/c.ts"])
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
			modelName: MODEL_NAME,
			usage: makeRunUsage(),
		})
		assert.isTrue(request.partial)
		assert.equal(request.report.verdict, "issues")
		assert.deepStrictEqual(request.report.unreviewed, ["src/b.ts"])
		assert.lengthOf(request.report.findings, 1)
	})
})
