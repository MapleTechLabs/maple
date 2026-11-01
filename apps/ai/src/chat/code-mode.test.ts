/**
 * `run_code` through the real engine, a scripted model and the in-process executor: what a program
 * can call, what it cannot, and which runs are offered the tool at all.
 */
import { OrgId, UserId } from "@maple/domain"
import { inProcessCodeExecutorLayer } from "@yielded/agent-testing/code-executor-substitute"
import { Effect, Exit, Layer, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import * as AiModel from "effect/ai/Model"
import { assert, describe, it } from "vitest"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { noRepositoryWarmup } from "../../test/chat/tool-executor"
import { layerLlm, type ResolvedModel } from "../platform/Llm"
import { prReviewSessionId, type ChatTurnOrigin } from "@maple/domain/chat-session"
import { CODE_MODE_TOOLS, RUN_CODE } from "./code-mode"
import { makeReviewLedger } from "./review-ledger"
import { AGENTS } from "./agents"
import { mapleToolCatalog } from "../mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import type { ChatTurnEvent } from "./events"
import { runChatTurn, type SettledChild } from "./run"
import { makeRunUsage } from "./tools"

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const INVESTIGATION = `${TENANT.orgId}:inv-0199a4d1-9f3c-7c8e-b2a1-3f5e7d9c1b40`
const USAGE = { inputTokens: { total: 1, uncached: 1 }, outputTokens: { total: 1, text: 1 } }

const callTool = (name: string, params: unknown): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: "tool-call", id: `call-${name}`, name, params },
	{ type: "finish", reason: "tool-calls", usage: USAGE },
]

const answer = (text: string): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: "text-start", id: "text-1" },
	{ type: "text-delta", id: "text-1", delta: text },
	{ type: "text-end", id: "text-1" },
	{ type: "finish", reason: "stop", usage: USAGE },
]

/** A model that plays `script` one response per call, recording each call's prompt and tool names. */
const scriptedModel = (script: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) => {
	const prompts: Array<Prompt.Prompt> = []
	const offered: Array<ReadonlyArray<string>> = []
	const respond = (options: LanguageModel.ProviderOptions) => {
		prompts.push(options.prompt)
		offered.push(options.tools.map((tool) => tool.name))
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
	return { model, prompts, offered }
}

/** Answers every tool with `<name> ran`, recording the names it was asked for. */
const recordingExecutor = () => {
	const dispatched: Array<string> = []
	const executor: McpToolExecutorApi = {
		...noRepositoryWarmup,
		execute: (_tenant, name) =>
			Effect.sync(() => {
				dispatched.push(name)
				return { content: [{ type: "text" as const, text: `${name} ran` }] }
			}),
	}
	return { executor, dispatched }
}

const llmClients = layerLlm({})

const run = (input: {
	readonly sessionId: string
	readonly origin: ChatTurnOrigin
	readonly model: ResolvedModel
	readonly executor: McpToolExecutorApi
	readonly withCode?: boolean
	readonly append?: (event: ChatTurnEvent) => void
}) =>
	Effect.runPromiseExit(
		runChatTurn({
			sessionId: input.sessionId,
			messageId: "msg-1",
			tenant: TENANT,
			origin: input.origin,
			toolExecutor: input.executor,
			model: input.model,
			submitDiagnosis: () => Effect.void,
			...(input.withCode === false ? undefined : { codeExecutor: inProcessCodeExecutorLayer }),
			text: "Investigate.",
			history: [],
			usage: makeRunUsage(),
			holdsTurn: () => true,
			append: input.append ?? (() => {}),
		}).pipe(Effect.provide(llmClients)),
	)

const toolResults = (prompt: Prompt.Prompt) =>
	prompt.content.flatMap((message) => (message.role === "tool" ? message.content : []))

describe("run_code", () => {
	it("runs a program's batched reads through the Maple tools in one model turn", async () => {
		const { model, prompts } = scriptedModel([
			callTool(RUN_CODE, {
				code: "async () => { const [a, b] = await Promise.all([maple.list_services({}), maple.find_errors({})]); return [a, b] }",
			}),
			callTool("submit_diagnosis", { summary: "s", evidence: "p99 tripled" }),
		])
		const { executor, dispatched } = recordingExecutor()

		const exit = await run({ sessionId: INVESTIGATION, origin: { kind: "autonomous" }, model, executor })

		assert.isTrue(Exit.isSuccess(exit) && exit.value.submitted, `run failed: ${String(exit)}`)
		assert.sameMembers(dispatched, ["list_services", "find_errors"])
		const result = toolResults(prompts[1]!).find(
			(part) => part.type === "tool-result" && part.name === RUN_CODE,
		)
		assert.include(JSON.stringify(result), "list_services ran")
		assert.include(JSON.stringify(result), "find_errors ran")
	})

	it("shows the reader each read a program made, with its UI payload, before the program's result", async () => {
		const { model } = scriptedModel([
			callTool(RUN_CODE, { code: "async () => (await maple.list_services({})).length" }),
			answer("Done."),
		])
		const executor: McpToolExecutorApi = {
			...noRepositoryWarmup,
			execute: () =>
				Effect.succeed({
					content: [{ type: "text" as const, text: "## Services" }],
					structuredContent: { services: [] },
				}),
		}
		const events: Array<ChatTurnEvent> = []

		await run({
			sessionId: INVESTIGATION,
			origin: { kind: "app" },
			model,
			executor,
			append: (event) => events.push(event),
		})

		const calls = events.flatMap((event) =>
			event.type === "tool-call" || event.type === "tool-result"
				? [`${event.type} ${event.callId}`]
				: [],
		)
		assert.deepStrictEqual(calls, [
			`tool-call call-${RUN_CODE}`,
			`tool-call call-${RUN_CODE}#0`,
			`tool-result call-${RUN_CODE}#0`,
			`tool-result call-${RUN_CODE}`,
		])
		const read = events.find(
			(event) => event.type === "tool-call" && event.callId === `call-${RUN_CODE}#0`,
		)
		assert.deepInclude(read, { name: "list_services", input: {} })
		const result = events.find(
			(event) => event.type === "tool-result" && event.callId === `call-${RUN_CODE}#0`,
		)
		assert.deepInclude(result, {
			output: {
				text: "## Services",
				ui: { __maple_ui: true, tool: "list_services", data: { services: [] } },
			},
		})
	})

	it("cannot reach a mutating or submit tool, even where the turn may propose one", async () => {
		const { model, prompts } = scriptedModel([
			callTool(RUN_CODE, {
				code: "async () => [typeof maple.create_dashboard, typeof maple.submit_diagnosis, typeof maple.list_services]",
			}),
			answer("Done."),
		])
		const { executor, dispatched } = recordingExecutor()

		// An attended follow-up runs the default ruleset, where writes are proposals.
		const exit = await run({ sessionId: INVESTIGATION, origin: { kind: "app" }, model, executor })

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		assert.deepEqual(dispatched, [])
		const result = toolResults(prompts[1]!).find(
			(part) => part.type === "tool-result" && part.name === RUN_CODE,
		)
		assert.include(JSON.stringify(result), '["undefined","undefined","function"]')
	})

	it("counts a program's diff reads toward the review's coverage", async () => {
		const observed: Array<string> = []
		const filed: Array<unknown> = []
		const { model } = scriptedModel([
			callTool(RUN_CODE, {
				code: 'async () => (await maple.pr_file_diff({ repository: "o/r", number: 1, paths: ["src/a.ts"] })).length',
			}),
			callTool("submit_review", { verdict: "clean", summary: "Adds a retry." }),
		])
		const exit = await Effect.runPromiseExit(
			runChatTurn({
				sessionId: prReviewSessionId(TENANT.orgId, "7f1d3c2e-9a4b-4c8d-8e2f-1a2b3c4d5e6f"),
				messageId: "msg-1",
				tenant: TENANT,
				origin: { kind: "autonomous" },
				toolExecutor: recordingExecutor().executor,
				model,
				submitDiagnosis: () => Effect.die("no investigation in a review session"),
				submitReview: (_org, _id, request) => Effect.sync(() => filed.push(request)),
				review: {
					coverage: {
						observe: (tool) => observed.push(tool),
						unread: () => [],
						wholeDiff: () => true,
					},
					ledger: makeReviewLedger(),
				},
				codeExecutor: inProcessCodeExecutorLayer,
				text: "Review pull request #1.",
				history: [],
				usage: makeRunUsage(),
				holdsTurn: () => true,
				append: () => {},
			}).pipe(Effect.provide(llmClients)),
		)

		assert.isTrue(Exit.isSuccess(exit) && exit.value.submitted, `run failed: ${String(exit)}`)
		assert.include(observed, "pr_file_diff")
		assert.lengthOf(filed, 1)
	})

	it("refuses a call to a tool outside the namespace without dispatching it", async () => {
		const { model, prompts } = scriptedModel([
			callTool(RUN_CODE, { code: 'async () => maple.create_dashboard({ title: "x" })' }),
			answer("Done."),
		])
		const { executor, dispatched } = recordingExecutor()

		const exit = await run({ sessionId: INVESTIGATION, origin: { kind: "app" }, model, executor })

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		assert.deepEqual(dispatched, [])
		const result = toolResults(prompts[1]!).find(
			(part) => part.type === "tool-result" && part.name === RUN_CODE,
		)
		assert.isTrue(result?.type === "tool-result" && result.isFailure)
	})

	it("spends the run's tool budget on a program's calls", async () => {
		const { model } = scriptedModel([
			callTool(RUN_CODE, {
				code: "async () => { const out = []; for (const _ of [1, 2, 3, 4, 5, 6]) out.push(await maple.list_services({})); return out }",
			}),
			answer("Done."),
		])
		const { executor, dispatched } = recordingExecutor()

		const exit = await Effect.runPromiseExit(
			runChatTurn({
				sessionId: INVESTIGATION,
				messageId: "msg-1",
				tenant: TENANT,
				origin: { kind: "app" },
				toolExecutor: executor,
				model,
				submitDiagnosis: () => Effect.void,
				agent: { ...AGENTS.investigate, budget: { ...AGENTS.investigate.budget, maxToolCalls: 3 } },
				codeExecutor: inProcessCodeExecutorLayer,
				text: "Investigate.",
				history: [],
				usage: makeRunUsage(),
				holdsTurn: () => true,
				append: () => {},
			}).pipe(Effect.provide(llmClients)),
		)

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		// The program's own call is one of the three, and it got to make the others.
		assert.isAtLeast(dispatched.length, 1)
		assert.isAtMost(dispatched.length, 2)
	})

	// Code-only children reach their reads through run_code alone, so the grant must name them too.
	it.each([false, true])(
		"gives a review's child reviewers run_code and its guidance (code-only: %s)",
		async (codeOnly) => {
			const { model, prompts, offered } = scriptedModel([
				callTool("review_files", {
					repository: "o/r",
					number: 1,
					headSha: "abc123",
					paths: ["src/a.ts"],
				}),
				callTool(RUN_CODE, {
					code: 'async () => (await maple.pr_file_diff({ repository: "o/r", number: 1, paths: ["src/a.ts"] })).length',
				}),
				answer("NO FINDINGS"),
				callTool("submit_review", { verdict: "clean", summary: "Adds a retry." }),
			])
			const { executor, dispatched } = recordingExecutor()
			const usage = makeRunUsage()
			const children: Array<SettledChild> = []

			const exit = await Effect.runPromiseExit(
				runChatTurn({
					sessionId: prReviewSessionId(TENANT.orgId, "7f1d3c2e-9a4b-4c8d-8e2f-1a2b3c4d5e6f"),
					messageId: "msg-1",
					tenant: TENANT,
					origin: { kind: "autonomous" },
					toolExecutor: executor,
					model,
					submitDiagnosis: () => Effect.die("no investigation in a review session"),
					submitReview: () => Effect.void,
					review: {
						coverage: { observe: () => {}, unread: () => [], wholeDiff: () => true },
						ledger: makeReviewLedger(),
					},
					codeExecutor: inProcessCodeExecutorLayer,
					codeOnly,
					text: "Review pull request #1.",
					history: [],
					usage,
					holdsTurn: () => true,
					append: () => {},
					onChildSettled: (child) => children.push(child),
				}).pipe(Effect.provide(llmClients)),
			)

			assert.isTrue(Exit.isSuccess(exit) && exit.value.submitted, `run failed: ${String(exit)}`)
			// Model call 2 is the child's first.
			assert.include(offered[1], RUN_CODE)
			assert.strictEqual(offered[1]!.includes("pr_file_diff"), !codeOnly)
			assert.include(JSON.stringify(prompts[1]!.content[0]), "Reading with run_code")
			assert.include(dispatched, "pr_file_diff")
			// The child's two model calls, counted apart from the parent's own usage.
			assert.strictEqual(usage.delegated.modelCalls, 2)
			// The child's own conversation, read back for the eval: its run_code call is in it.
			assert.lengthOf(children, 1)
			assert.include(JSON.stringify(children[0]?.history), RUN_CODE)
			// ...and billed with them: four calls of one input token each.
			assert.strictEqual(usage.input, 4)
			assert.strictEqual(
				usage.charges.reduce((sum, charge) => sum + charge.inputTokens, 0),
				4,
			)
		},
	)

	it("withholds the direct read tools in code-only runs, keeping their schemas in run_code", async () => {
		const { model, offered } = scriptedModel([answer("Hi.")])
		await Effect.runPromiseExit(
			runChatTurn({
				sessionId: INVESTIGATION,
				messageId: "msg-1",
				tenant: TENANT,
				origin: { kind: "autonomous" },
				toolExecutor: recordingExecutor().executor,
				model,
				submitDiagnosis: () => Effect.void,
				codeExecutor: inProcessCodeExecutorLayer,
				codeOnly: true,
				text: "Investigate.",
				history: [],
				usage: makeRunUsage(),
				holdsTurn: () => true,
				append: () => {},
			}).pipe(Effect.provide(llmClients)),
		)

		assert.include(offered[0], RUN_CODE)
		assert.include(offered[0], "submit_diagnosis")
		assert.notInclude(offered[0], "list_services")
		assert.notInclude(offered[0], "run_sql")
	})

	it("lists only registered, read-only tools", () => {
		const registered = new Set(mapleToolCatalog.map((definition) => definition.name))
		const unknown = [...CODE_MODE_TOOLS].filter(
			(name) => !registered.has(name) || MUTATING_TOOL_NAMES.has(name),
		)
		assert.deepEqual(unknown, [])
	})

	it("is offered to investigations and reviews only, and only with an executor", async () => {
		const offeredTo = async (sessionId: string, withCode: boolean) => {
			const { model, offered } = scriptedModel([answer("Hi.")])
			await run({
				sessionId,
				origin: { kind: "app" },
				model,
				executor: recordingExecutor().executor,
				withCode,
			})
			return offered[0]!.includes(RUN_CODE)
		}

		assert.isTrue(await offeredTo(INVESTIGATION, true))
		assert.isFalse(await offeredTo(INVESTIGATION, false))
		assert.isFalse(await offeredTo(`${TENANT.orgId}:tab-1`, true))
	})
})
