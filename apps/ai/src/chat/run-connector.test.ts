/**
 * A connector turn through the real engine and a scripted model: what the model is offered and
 * what reaches the executor, for an asker Maple can name and for one it cannot.
 */
import { OrgId, UserId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import {
	ChatConnectorId,
	ChatConversationKey,
	connectorSessionId,
	type ChatTurnOrigin,
} from "@maple/domain/chat-session"
import type { TenantContext } from "@maple/domain/http"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { ExternalUserId, RoleName } from "@maple/primitives"
import { Effect, Exit, Layer, Schema, Stream, Array as Arr } from "effect"
import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import * as AiModel from "effect/ai/Model"
import { assert, describe, it } from "vitest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { mapleToolCatalog, mapleToolCatalogFor } from "../mcp/tools/registry"
import { noRepositoryWarmup } from "../../test/chat/tool-executor"
import { layerLlm, type ResolvedModel } from "../platform/Llm"
import { agentForSession } from "./agents"
import { MUTATING_TOOL_NAMES } from "./permissions"
import { runChatTurn } from "./run"
import { dataSourcesContext } from "./turn-runner"
import { makeRunUsage } from "./usage"

const ORG = Schema.decodeSync(OrgId)("org_test")
const TENANT: TenantContext = {
	orgId: ORG,
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	permissions: Policy.grantsOf([]),
	authMode: "self_hosted",
}
const SESSION = connectorSessionId(
	ORG,
	Schema.decodeSync(ChatConnectorId)("testchat"),
	Schema.decodeSync(ChatConversationKey)("c1"),
)

/** Someone the host could not resolve to a Maple user: a connector with no account linking. */
const ANONYMOUS: ChatTurnOrigin = {
	kind: "connector",
	connectorId: Schema.decodeSync(ChatConnectorId)("testchat"),
	workspaceId: "w1",
	externalUserId: Schema.decodeSync(ExternalUserId)("u-1"),
	displayName: "Ada",
}
const LINKED: ChatTurnOrigin = { ...ANONYMOUS, actingUserId: Schema.decodeSync(UserId)("user_ada") }
/** The tenant a linked asker's turn runs as: their own membership, here an engineer's. */
/** An admin, who holds every permission: the linked asker is offered the whole bot catalog. */
const LINKED_TENANT: TenantContext = {
	...TENANT,
	roles: [Schema.decodeSync(RoleName)("org:admin")],
	permissions: Policy.grantsOf(["org:admin"]),
}

const USAGE = { inputTokens: { total: 1, uncached: 1 }, outputTokens: { total: 1, text: 1 } }

const callTool = (name: string): ReadonlyArray<Response.StreamPartEncoded> => [
	{ type: "tool-call", id: `call-${name}`, name, params: {} },
	{ type: "finish", reason: "tool-calls", usage: USAGE },
]

const answer: ReadonlyArray<Response.StreamPartEncoded> = [
	{ type: "text-start", id: "text-1" },
	{ type: "text-delta", id: "text-1", delta: "Done." },
	{ type: "text-end", id: "text-1" },
	{ type: "finish", reason: "stop", usage: USAGE },
]

/** Plays `script` one response per call, recording the tool names each call was offered. */
const scriptedModel = (script: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) => {
	const offered: Array<ReadonlyArray<string>> = []
	const model: ResolvedModel = {
		provider: "openrouter",
		content: "record",
		name: "scripted",
		limits: { context: 100_000, output: 4_000 },
		layer: AiModel.make(
			"openrouter",
			"scripted",
			Layer.effect(
				LanguageModel.LanguageModel,
				LanguageModel.make({
					generateText: () => Effect.die("the turn streams; generateText is never called"),
					streamText: (options) =>
						Stream.suspend(() => {
							offered.push(Arr.map(options.tools, (tool) => tool.name))
							return Stream.fromIterable(script[offered.length - 1] ?? answer)
						}),
				}),
			),
		),
	}
	return { model, offered }
}

/** Answers every tool, recording what it was asked for, on which surface, and each data source read. */
const recordingExecutor = () => {
	const dispatched: Array<{ readonly name: string; readonly surface: McpToolSurface }> = []
	const reads = { dataSources: 0 }
	const executor: McpToolExecutorApi = {
		...noRepositoryWarmup,
		execute: (_tenant, name, _input, surface) =>
			Effect.sync(() => {
				dispatched.push({ name, surface })
				return { content: [{ type: "text" as const, text: `${name} ran` }] }
			}),
		listDataSources: () =>
			Effect.sync(() => {
				reads.dataSources += 1
				return []
			}),
	}
	return { executor, dispatched, reads }
}

const run = (
	origin: ChatTurnOrigin,
	model: ResolvedModel,
	executor: McpToolExecutorApi,
	tenant: TenantContext = TENANT,
): Promise<Exit.Exit<unknown, unknown>> =>
	Effect.runPromiseExit(
		runChatTurn({
			sessionId: SESSION,
			messageId: "msg-1",
			tenant,
			origin,
			toolExecutor: executor,
			model,
			text: "how is checkout doing?",
			history: [],
			usage: makeRunUsage(),
			holdsTurn: () => true,
			append: () => {},
		}).pipe(Effect.provide(layerLlm({}))),
	)

const registered = new Set(Arr.map(mapleToolCatalog, (tool) => tool.name))
const mapleTools = (names: ReadonlyArray<string>) => Arr.filter(names, (name) => registered.has(name)).sort()

describe("a connector turn nobody is named on", () => {
	it("offers the model exactly the read tools its surface lists", async () => {
		const { model, offered } = scriptedModel([answer])
		const exit = await run(ANONYMOUS, model, recordingExecutor().executor)

		assert.isTrue(Exit.isSuccess(exit), `run failed: ${String(exit)}`)
		const tools = mapleTools(offered[0] ?? [])
		assert.isNotEmpty(tools)
		assert.deepEqual(tools, Arr.map(mapleToolCatalogFor("bot_anonymous"), (tool) => tool.name).sort())
		// Nothing that changes data, so there is nothing to propose.
		assert.deepEqual(
			Arr.filter(tools, (name) => MUTATING_TOOL_NAMES.has(name)),
			[],
		)
	})

	it("offers a linked asker on the same conversation more: the reads withheld above, and changes", async () => {
		const anonymous = scriptedModel([answer])
		const linked = scriptedModel([answer])
		await run(ANONYMOUS, anonymous.model, recordingExecutor().executor)
		await run(LINKED, linked.model, recordingExecutor().executor, LINKED_TENANT)

		const narrow = new Set(mapleTools(anonymous.offered[0] ?? []))
		const wide = mapleTools(linked.offered[0] ?? [])
		assert.deepEqual(wide, Arr.map(mapleToolCatalogFor("bot"), (tool) => tool.name).sort())
		const extra = Arr.filter(wide, (name) => !narrow.has(name))
		for (const name of [
			"run_sql",
			"query_data_source",
			"search_sessions",
			"sandbox_exec",
			"list_users",
		]) {
			assert.include(extra, name)
		}
		assert.isNotEmpty(Arr.filter(extra, (name) => MUTATING_TOOL_NAMES.has(name)))
	})

	it("dispatches a listed tool on the surface the registry narrows", async () => {
		const { model } = scriptedModel([callTool("list_services"), answer])
		const { executor, dispatched } = recordingExecutor()
		await run(ANONYMOUS, model, executor)

		assert.deepEqual(dispatched, [{ name: "list_services", surface: "bot_anonymous" }])
	})

	it("never reaches the executor for a withheld tool the model names anyway", async () => {
		const { model } = scriptedModel([callTool("run_sql"), answer])
		const { executor, dispatched } = recordingExecutor()
		await run(ANONYMOUS, model, executor)

		assert.deepEqual(dispatched, [])
	})
})

describe("the data sources a turn's prompt names", () => {
	const context = (origin: ChatTurnOrigin, executor: McpToolExecutorApi) =>
		Effect.runPromise(
			dataSourcesContext(agentForSession(SESSION), origin, executor, TENANT, {
				sessionId: SESSION,
				turnId: "msg-1",
			}),
		)

	it("does not read them for a turn nobody is named on", async () => {
		const { executor, reads } = recordingExecutor()

		assert.isUndefined(await context(ANONYMOUS, executor))
		assert.equal(reads.dataSources, 0)
	})

	it("reads them once for a linked asker and for the app", async () => {
		const { executor, reads } = recordingExecutor()
		await context(LINKED, executor)
		await context({ kind: "app" }, executor)

		assert.equal(reads.dataSources, 2)
	})
})
