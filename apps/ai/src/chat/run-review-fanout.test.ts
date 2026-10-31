/**
 * A review's `review_files` children, through the real engine and a scripted model.
 *
 * The children run the parent's own Maple handlers, so anything those handlers keep per build is
 * shared with them. These pin the two places that went wrong in production: the repeated-call guard
 * refused a child's first call because the parent had spent the budget, and a child's
 * `invoke_agent` span was filed under the child's own thread instead of the review's session.
 */
import { OrgId, UserId } from "@maple/domain"
import type { SubmitPrReviewRequest } from "@maple/domain/http"
import { prReviewSessionId } from "@maple/domain/chat-session"
import { Effect, Exit, Layer, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import * as AiModel from "effect/ai/Model"
import { assert, describe, it } from "vitest"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { makeRecordingTracer } from "@maple/backend/testing/recording-tracer"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { noRepositoryWarmup } from "../../test/chat/tool-executor"
import { layerLlm, type ResolvedModel } from "../platform/Llm"
import { runChatTurn } from "./run"
import { makeChildFindings } from "./review-child-findings"
import { makeReviewLedger } from "./review-ledger"
import { makeRunUsage } from "./tools"
import { interruptOnAbort, makeTurnObservability } from "./turn-outcome"

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const REVIEW_SESSION = prReviewSessionId(TENANT.orgId, "7f1d3c2e-9a4b-4c8d-8e2f-1a2b3c4d5e6f")
const USAGE = { inputTokens: { total: 1, uncached: 1 }, outputTokens: { total: 1, text: 1 } }
const CHANGED_FILES = { repository: "acme/shop", number: 7 }

const callTool = (id: string, name: string, params: unknown): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: "tool-call", id, name, params },
	{ type: "finish", reason: "tool-calls", usage: USAGE },
]

const answer = (text: string): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: "text-start", id: "text-1" },
	{ type: "text-delta", id: "text-1", delta: text },
	{ type: "text-end", id: "text-1" },
	{ type: "finish", reason: "stop", usage: USAGE },
]

/** Placeholder provider clients the scripted model never calls; `runChatTurn` requires them. */
const llmClients = layerLlm({})

/** One response per model call, parent and child alike, in the order the engine asks. */
const scriptedModel = (script: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>): ResolvedModel => {
	let calls = 0
	const respond = () => script[calls++] ?? answer("(script ran out)")
	return {
		provider: "openrouter",
		name: "scripted",
		limits: { context: 100_000, output: 4_000 },
		tags: { surface: "chat", orgId: TENANT.orgId, sessionId: REVIEW_SESSION, turnId: "turn-1" },
		layer: AiModel.make(
			"openrouter",
			"scripted",
			Layer.effect(
				LanguageModel.LanguageModel,
				LanguageModel.make({
					generateText: () => Effect.die("the turn streams; generateText is never called"),
					streamText: () => Stream.suspend(() => Stream.fromIterable(respond())),
				}),
			),
		),
	}
}

describe("runChatTurn review_files children", () => {
	it("gives a child its own repeated-call budget and files its spans under the review", async () => {
		const dispatched: Array<string> = []
		const executor: McpToolExecutorApi = {
			...noRepositoryWarmup,
			execute: (_tenant, name) =>
				Effect.sync(() => {
					dispatched.push(name)
					return { content: [{ type: "text" as const, text: "src/a.ts (source, +3 -1)" }] }
				}),
		}
		// The parent spends the identical-call budget, then hands a group to a child that asks the
		// same question first, as every worker does.
		const model = scriptedModel([
			callTool("p-1", "pr_changed_files", CHANGED_FILES),
			callTool("p-2", "pr_changed_files", CHANGED_FILES),
			callTool("p-3", "pr_changed_files", CHANGED_FILES),
			callTool("p-4", "review_files", {
				repository: "acme/shop",
				number: 7,
				headSha: "abc123",
				paths: ["src/a.ts"],
			}),
			callTool("c-1", "pr_changed_files", CHANGED_FILES),
			answer("NO FINDINGS"),
			answer("Reviewed."),
		])
		const { spans, tracer } = makeRecordingTracer()

		const exit = await Effect.runPromiseExit(
			runChatTurn({
				sessionId: REVIEW_SESSION,
				messageId: "msg-1",
				tenant: TENANT,
				origin: { kind: "autonomous" },
				toolExecutor: executor,
				model,
				submitDiagnosis: () => Effect.die("no investigation in a review session"),
				submitReview: () => Effect.void,
				review: {
					coverage: { observe: () => {}, unread: () => [], wholeDiff: true },
					ledger: makeReviewLedger(),
				},
				text: "Review pull request #7 of acme/shop.",
				history: [],
				usage: makeRunUsage(),
				holdsTurn: () => true,
				append: () => {},
			}).pipe(Effect.withTracer(tracer), Effect.provide(llmClients)),
		)

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		assert.deepEqual(
			dispatched,
			["pr_changed_files", "pr_changed_files", "pr_changed_files", "pr_changed_files"],
			"the child's first call reaches the executor",
		)

		const worker = spans.find((span) => span.name === "invoke_agent pr-review-worker")
		assert.isDefined(worker, "the child ran")
		assert.notStrictEqual(worker?.attributes.get("gen_ai.conversation.id"), REVIEW_SESSION)
		assert.strictEqual(worker?.attributes.get("maple_ai.session.id"), REVIEW_SESSION)
		assert.strictEqual(worker?.attributes.get("maple_ai.turn.id"), "turn-1")
		for (const span of spans.filter((span) => span.name.startsWith("execute_tool "))) {
			assert.strictEqual(span.attributes.get("maple_ai.session.id"), REVIEW_SESSION, span.name)
		}
	})

	it("holds a continuation's review to the warnings the first run's children reported", async () => {
		const executor: McpToolExecutorApi = {
			...noRepositoryWarmup,
			execute: () =>
				Effect.succeed({ content: [{ type: "text" as const, text: "src/a.ts (source, +3 -1)" }] }),
		}
		const review = {
			coverage: { observe: () => {}, unread: () => [], wholeDiff: true },
			ledger: makeReviewLedger(),
			childFindings: makeChildFindings(),
		}
		const filed: Array<SubmitPrReviewRequest> = []
		const run = (model: ResolvedModel) =>
			Effect.runPromiseExit(
				runChatTurn({
					sessionId: REVIEW_SESSION,
					messageId: "msg-1",
					tenant: TENANT,
					origin: { kind: "autonomous" },
					toolExecutor: executor,
					model,
					submitDiagnosis: () => Effect.die("no investigation in a review session"),
					submitReview: (_org, _id, request) => Effect.sync(() => filed.push(request)),
					review,
					text: "Review pull request #7 of acme/shop.",
					history: [],
					usage: makeRunUsage(),
					holdsTurn: () => true,
					append: () => {},
				}).pipe(Effect.provide(llmClients)),
			)
		const clean = { verdict: "clean", summary: "Adds a retry." }

		// The first run's child reports a warning; the parent then stops in prose without submitting.
		await run(
			scriptedModel([
				callTool("p-1", "review_files", {
					repository: "acme/shop",
					number: 7,
					headSha: "abc123",
					paths: ["src/a.ts"],
				}),
				answer("src/a.ts:3 | warn | correctness | Retry never stops | Loops on 4xx | Bound it | -"),
				answer("Reviewed."),
			]),
		)
		await run(
			scriptedModel([
				callTool("q-1", "submit_review", clean),
				callTool("q-2", "submit_review", clean),
				answer("Done."),
			]),
		)

		assert.deepStrictEqual(
			filed.map((request) => request.report.findings.map((finding) => [finding.path, finding.line])),
			[[["src/a.ts", 3]]],
		)
	})

	it("interrupts a superseded turn's in-flight child instead of letting it run to its next event", async () => {
		const supersede = new AbortController()
		let childInterrupted = false
		// The child's first call never answers on its own, as a worker mid-tool does.
		const executor: McpToolExecutorApi = {
			...noRepositoryWarmup,
			execute: () =>
				Effect.sync(() => supersede.abort("superseded")).pipe(
					Effect.andThen(Effect.never),
					Effect.onInterrupt(() =>
						Effect.sync(() => {
							childInterrupted = true
						}),
					),
				),
		}
		const model = scriptedModel([
			callTool("p-1", "review_files", {
				repository: "acme/shop",
				number: 7,
				headSha: "abc123",
				paths: ["src/a.ts"],
			}),
			callTool("c-1", "pr_changed_files", CHANGED_FILES),
		])
		const { spans, tracer } = makeRecordingTracer()
		const observability = makeTurnObservability()

		const exit = await Effect.runPromiseExit(
			runChatTurn({
				sessionId: REVIEW_SESSION,
				messageId: "msg-1",
				tenant: TENANT,
				origin: { kind: "autonomous" },
				toolExecutor: executor,
				model,
				submitDiagnosis: () => Effect.die("no investigation in a review session"),
				submitReview: () => Effect.void,
				review: {
					coverage: { observe: () => {}, unread: () => [], wholeDiff: true },
					ledger: makeReviewLedger(),
				},
				text: "Review pull request #7 of acme/shop.",
				history: [],
				usage: makeRunUsage(),
				// The claim is still held: only the interrupt can stop this run.
				holdsTurn: () => true,
				append: () => {},
			}).pipe(
				Effect.asVoid,
				interruptOnAbort(supersede.signal, observability),
				Effect.withSpan("chat.turn"),
				Effect.withTracer(tracer),
				Effect.provide(llmClients),
			),
		)

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		assert.isTrue(childInterrupted, "the child's in-flight call was interrupted")
		assert.strictEqual(observability.outcome, "aborted")
		const turn = spans.find((span) => span.name === "chat.turn")
		assert.strictEqual(turn?.attributes.get("maple.chat.outcome"), "aborted")
		assert.strictEqual(turn?.attributes.get("maple.chat.abort_reason"), "superseded")
	})
})
