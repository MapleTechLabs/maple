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
			completion!.handlers[SUBMIT_DIAGNOSIS](sampleSubmission(), {} as never).pipe(
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
		const coverage = (unread: ReadonlyArray<string>): ReviewCoverage => ({
			observe: () => {},
			unread: () => unread,
		})
		const recording = () => {
			const filed: Array<unknown> = []
			const submit: SubmitReview = (_org, _id, request) => Effect.sync(() => filed.push(request))
			return { filed, submit }
		}
		const submitWith = (submit: SubmitReview, unread: ReadonlyArray<string>, partial = false) => {
			const completion = buildReviewCompletion(
				REVIEW_SESSION,
				tenantFor(human),
				{ kind: "autonomous" },
				submit,
				makeRunUsage(),
				MODEL_NAME,
				partial,
				undefined,
				coverage(unread),
			)
			assert.isDefined(completion)
			return {
				completion: completion!,
				call: (submission: PrReviewSubmission) =>
					Effect.runPromise(
						Effect.result(completion!.handlers[SUBMIT_REVIEW](submission, {} as never)),
					),
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
			{ observe: () => {}, unread: () => unread },
			ledger,
		)
		assert.isDefined(completion)
		const handlers = completion!.handlers
		return {
			filed,
			ledger,
			save: (finding: PrReviewFindingSubmission) =>
				Effect.runPromise(Effect.result(handlers[RECORD_FINDING](finding, {} as never))),
			submit: (submission: PrReviewSubmission) =>
				Effect.runPromise(Effect.result(handlers[SUBMIT_REVIEW](submission, {} as never))),
		}
	}

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
