/**
 * What a failed tool call does to a whole run, through the real engine and a scripted model.
 *
 * The handler tests pin each tool's `failureMode`; this pins what the engine does with it. A rejected
 * query must reach the model as a failed result it can rewrite, and a gated proposal must still end
 * the run — as a finished turn with the proposal open.
 */
import { OrgId, UserId } from "@maple/domain"
import { prReplySessionId, prReviewSessionId } from "@maple/domain/chat-session"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import * as AiModel from "effect/ai/Model"
import { assert, describe, it } from "vitest"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { makeRecordingTracer } from "@maple/backend/testing/recording-tracer"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { noRepositoryWarmup } from "../../test/chat/tool-executor"
import { layerLlm, type ResolvedModel } from "../platform/Llm"
import type { ChatTurnEvent } from "./events"
import { runChatTurn } from "./run"
import { makeReviewLedger } from "./review-ledger"
import { makeRunUsage } from "./tools"

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const USAGE = { inputTokens: { total: 1, uncached: 1 }, outputTokens: { total: 1, text: 1 } }

const callTool = (name: string, params: unknown): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: "tool-call", id: "call-1", name, params },
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

/** A model that plays `script` one response per call, recording every prompt it was sent. */
const scriptedModel = (script: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) => {
	const prompts: Array<Prompt.Prompt> = []
	const respond = (options: LanguageModel.ProviderOptions) => {
		prompts.push(options.prompt)
		return script[prompts.length - 1] ?? answer("(script ran out)")
	}
	const model: ResolvedModel = {
		provider: "openrouter",
		name: "scripted",
		limits: { context: 100_000, output: 4_000 },
		layer: AiModel.make(
			"openrouter",
			"scripted",
			Layer.effect(
				LanguageModel.LanguageModel,
				LanguageModel.make({
					generateText: () => Effect.die("the turn streams; generateText is never called"),
					streamText: (options) => Stream.suspend(() => Stream.fromIterable(respond(options))),
				}),
			),
		),
	}
	return { model, prompts }
}

const run = (model: ResolvedModel, executor: McpToolExecutorApi) => {
	const events: Array<ChatTurnEvent> = []
	const effect = runChatTurn({
		sessionId: "org_test:tab-1",
		messageId: "msg-1",
		tenant: TENANT,
		origin: { kind: "app" },
		toolExecutor: executor,
		model,
		submitDiagnosis: () => Effect.die("no investigation in a default session"),
		text: "how many services?",
		history: [],
		usage: makeRunUsage(),
		holdsTurn: () => true,
		append: (event) => events.push(event),
	})
	return { effect, events }
}

const rejectingExecutor: McpToolExecutorApi = {
	...noRepositoryWarmup,
	execute: () =>
		Effect.succeed({
			isError: true,
			content: [{ type: "text" as const, text: "SQL rejected (MissingOrgFilter)" }],
		}),
}

describe("runChatTurn tool failures", () => {
	it("hands a rejected query back to the model and finishes the run", async () => {
		const { model, prompts } = scriptedModel([
			callTool("run_sql", { sql: "select 1" }),
			answer("Rewrote it."),
		])
		const { effect, events } = run(model, rejectingExecutor)

		const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(llmClients)))

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		assert.lengthOf(prompts, 2, "the model is called again after the failed tool")
		const results = prompts[1]!.content.flatMap((message) =>
			message.role === "tool" ? message.content : [],
		)
		assert.deepInclude(
			results.map(
				(part) => part.type === "tool-result" && { name: part.name, isFailure: part.isFailure },
			),
			{ name: "run_sql", isFailure: true },
		)
		assert.deepInclude(
			events.map(
				(event) => event.type === "tool-result" && { output: event.output, isError: event.isError },
			),
			{ output: "SQL rejected (MissingOrgFilter)", isError: true },
		)
		assert.deepEqual(events.at(-1), { type: "turn-end", messageId: "msg-1", reason: "stop" })
	})

	it("ends the run on a gated proposal, leaving it open", async () => {
		const { model, prompts } = scriptedModel([
			callTool("create_dashboard", { name: "Checkout" }),
			answer("should never be asked"),
		])
		const { effect, events } = run(model, rejectingExecutor)

		const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(llmClients)))

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		assert.lengthOf(prompts, 1, "a proposal is the turn's last word")
		// Open until someone decides it: the gate's refusal is not its result, and the turn that
		// stopped on it finished rather than failed.
		assert.deepEqual(events, [
			{ type: "turn-start", messageId: "msg-1" },
			{
				type: "tool-call",
				messageId: "msg-1",
				callId: "call-1",
				label: "Creating a dashboard",
				name: "create_dashboard",
				input: { name: "Checkout" },
				proposed: true,
			},
			{ type: "turn-end", messageId: "msg-1", reason: "stop" },
		])
	})
})

describe("runChatTurn diagnosis rejections", () => {
	// A malformed submission used to fail the model stream and lose the whole investigation.
	it("hands a rejected submit_diagnosis back to the model, which submits again", async () => {
		const filed: Array<unknown> = []
		const { model, prompts } = scriptedModel([
			callTool("submit_diagnosis", { summary: "s", evidence: 42 }),
			callTool("submit_diagnosis", {
				summary: "s",
				evidence: "p99 tripled",
				suggestedActions: "Roll back",
			}),
			answer("Filed."),
		])
		const effect = runChatTurn({
			sessionId: `${TENANT.orgId}:inv-0199a4d1-9f3c-7c8e-b2a1-3f5e7d9c1b40`,
			messageId: "msg-1",
			tenant: TENANT,
			origin: { kind: "autonomous" },
			toolExecutor: rejectingExecutor,
			model,
			submitDiagnosis: (_org, _id, request) => Effect.sync(() => filed.push(request.report)),
			text: "Investigate.",
			history: [],
			usage: makeRunUsage(),
			holdsTurn: () => true,
			append: () => {},
		})

		const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(llmClients)))

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		assert.isTrue(Exit.isSuccess(exit) && exit.value.submitted)
		// The rejection is a failed tool result the model reads, not a retried model call.
		const results = prompts[1]!.content.flatMap((message) =>
			message.role === "tool" ? message.content : [],
		)
		assert.deepInclude(
			results.map(
				(part) => part.type === "tool-result" && { name: part.name, isFailure: part.isFailure },
			),
			{ name: "submit_diagnosis", isFailure: true },
		)
		assert.lengthOf(filed, 1)
		assert.deepInclude(filed[0], { suggestedActions: ["Roll back"] })
		assert.lengthOf(prompts, 2, "the landed submission ends the run")
	})

	it("ends the turn on a landed submit_diagnosis, without another model call or an error span", async () => {
		const { model, prompts } = scriptedModel([
			callTool("submit_diagnosis", { summary: "s", evidence: "p99 tripled" }),
			answer("I have filed the diagnosis."),
		])
		const events: Array<ChatTurnEvent> = []
		const effect = runChatTurn({
			sessionId: `${TENANT.orgId}:inv-0199a4d1-9f3c-7c8e-b2a1-3f5e7d9c1b40`,
			messageId: "msg-1",
			tenant: TENANT,
			origin: { kind: "autonomous" },
			toolExecutor: rejectingExecutor,
			model,
			submitDiagnosis: () => Effect.void,
			text: "Investigate.",
			history: [],
			usage: makeRunUsage(),
			holdsTurn: () => true,
			append: (event) => events.push(event),
		})
		const { spans, tracer } = makeRecordingTracer()

		const exit = await Effect.runPromiseExit(
			effect.pipe(Effect.provide(llmClients), Effect.withTracer(tracer)),
		)

		assert.isTrue(Exit.isSuccess(exit) && exit.value.submitted, `run failed: ${String(exit)}`)
		assert.lengthOf(prompts, 1)
		assert.isFalse(events.some((event) => event.type === "text-delta"))
		// Settling is not a failure: Maple's own error tracking would file every investigation.
		const failed = spans.filter(
			(span) =>
				span.status._tag === "Ended" &&
				Exit.isFailure(span.status.exit) &&
				!Cause.hasInterruptsOnly(span.status.exit.cause),
		)
		assert.deepEqual(
			failed.map((span) => span.name),
			[],
		)
		assert.deepEqual(events.at(-1), { type: "turn-end", messageId: "msg-1", reason: "stop" })
	})

	it("keeps a landed submission when the turn dies after it", async () => {
		const filed: Array<unknown> = []
		const { model, prompts } = scriptedModel([
			callTool("submit_diagnosis", { summary: "s", evidence: "p99 tripled" }),
			answer("I have filed the diagnosis."),
		])
		const effect = runChatTurn({
			sessionId: `${TENANT.orgId}:inv-0199a4d1-9f3c-7c8e-b2a1-3f5e7d9c1b40`,
			messageId: "msg-1",
			tenant: TENANT,
			origin: { kind: "autonomous" },
			toolExecutor: rejectingExecutor,
			model,
			submitDiagnosis: (_org, _id, request) => Effect.sync(() => filed.push(request.report)),
			text: "Investigate.",
			history: [],
			usage: makeRunUsage(),
			holdsTurn: () => true,
			// The sink dies on the submission's own result, after the report has landed.
			append: (event) => {
				if (event.type === "tool-result") throw new Error("sink crashed")
			},
		})

		const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(llmClients)))

		assert.isTrue(Exit.isSuccess(exit) && exit.value.submitted, `run failed: ${String(exit)}`)
		assert.lengthOf(prompts, 1)
		assert.lengthOf(filed, 1)
	})

	it("lets the calls batched with a landed submission finish before the turn ends", async () => {
		const { model, prompts } = scriptedModel([
			[
				{ type: "tool-call", id: "call-1", name: "run_sql", params: { sql: "select 1" } },
				{
					type: "tool-call",
					id: "call-2",
					name: "submit_diagnosis",
					params: { summary: "s", evidence: "p99 tripled" },
				},
				{ type: "finish", reason: "tool-calls", usage: USAGE },
			],
			answer("I have filed the diagnosis."),
		])
		const events: Array<ChatTurnEvent> = []
		const slowExecutor: McpToolExecutorApi = {
			...noRepositoryWarmup,
			execute: () =>
				Effect.sleep("20 millis").pipe(
					Effect.as({ content: [{ type: "text" as const, text: "1 row" }] }),
				),
		}
		const effect = runChatTurn({
			sessionId: `${TENANT.orgId}:inv-0199a4d1-9f3c-7c8e-b2a1-3f5e7d9c1b40`,
			messageId: "msg-1",
			tenant: TENANT,
			origin: { kind: "autonomous" },
			toolExecutor: slowExecutor,
			model,
			submitDiagnosis: () => Effect.void,
			text: "Investigate.",
			history: [],
			usage: makeRunUsage(),
			holdsTurn: () => true,
			append: (event) => events.push(event),
		})

		const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(llmClients)))

		assert.isTrue(Exit.isSuccess(exit) && exit.value.submitted, `run failed: ${String(exit)}`)
		assert.lengthOf(prompts, 1)
		assert.deepInclude(
			events.map(
				(event) => event.type === "tool-result" && { callId: event.callId, output: event.output },
			),
			{ callId: "call-1", output: "1 row" },
		)
		assert.deepEqual(events.at(-1), { type: "turn-end", messageId: "msg-1", reason: "stop" })
	})
})

describe("runChatTurn reply rejections", () => {
	it("hands a malformed propose_edit back to the model, which still replies", async () => {
		const posted: Array<string> = []
		const { model, prompts } = scriptedModel([
			callTool("propose_edit", { path: "src/a.ts" }),
			callTool("submit_reply", { body: "Done." }),
			answer("Posted."),
		])
		const effect = runChatTurn({
			sessionId: prReplySessionId(TENANT.orgId, "3c2e9a4b-7f1d-4c8d-8e2f-1a2b3c4d5e6f"),
			messageId: "msg-1",
			tenant: TENANT,
			origin: { kind: "autonomous" },
			toolExecutor: rejectingExecutor,
			model,
			submitDiagnosis: () => Effect.die("no investigation in a reply session"),
			submitReply: (_org, _id, body) => Effect.sync(() => (posted.push(body), "posted")),
			stageEdit: () => Effect.die("a malformed edit must never reach staging"),
			text: "@maple fix this",
			history: [],
			usage: makeRunUsage(),
			holdsTurn: () => true,
			append: () => {},
		})

		const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(llmClients)))

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		const results = prompts[1]!.content.flatMap((message) =>
			message.role === "tool" ? message.content : [],
		)
		assert.deepInclude(
			results.map(
				(part) => part.type === "tool-result" && { name: part.name, isFailure: part.isFailure },
			),
			{ name: "propose_edit", isFailure: true },
		)
		assert.deepEqual(posted, ["Done."])
	})
})

describe("runChatTurn review refusals", () => {
	const REVIEW_SESSION = prReviewSessionId(TENANT.orgId, "7f1d3c2e-9a4b-4c8d-8e2f-1a2b3c4d5e6f")
	const CLEAN = { verdict: "clean", summary: "Adds a retry to the order client." }

	// The unread-files refusal asks for a second call, so it has to reach the model rather than end the run.
	it("hands the unread-files refusal back to the model, which submits again", async () => {
		const filed: Array<unknown> = []
		const { model, prompts } = scriptedModel([
			callTool("submit_review", CLEAN),
			callTool("submit_review", CLEAN),
			answer("Filed."),
		])
		const effect = runChatTurn({
			sessionId: REVIEW_SESSION,
			messageId: "msg-1",
			tenant: TENANT,
			origin: { kind: "autonomous" },
			toolExecutor: rejectingExecutor,
			model,
			submitDiagnosis: () => Effect.die("no investigation in a review session"),
			submitReview: (_org, _id, request) => Effect.sync(() => filed.push(request)),
			review: {
				coverage: { observe: () => {}, unread: () => ["src/b.ts"], wholeDiff: () => true },
				ledger: makeReviewLedger(),
			},
			text: "Review pull request #1.",
			history: [],
			usage: makeRunUsage(),
			holdsTurn: () => true,
			append: () => {},
		})

		const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(llmClients)))

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		assert.isTrue(Exit.isSuccess(exit) && exit.value.submitted)
		assert.isAtLeast(prompts.length, 2, "the model is called again after the refusal")
		assert.lengthOf(filed, 1)
	})
})
