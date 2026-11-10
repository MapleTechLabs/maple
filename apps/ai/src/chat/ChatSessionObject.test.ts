import { assert, describe, it } from "@effect/vitest"
import { encodeChatTurnTenant, type ChatTurnTenant } from "@maple/domain/chat-session"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect, Layer, Option, Array as Arr } from "effect"
import { applyChatSessionMigrations, makeFakeDurableObjectState } from "../../test/chat/fake-do-state"
import {
	AuditEventsQueueProducer,
	DataSourceDevelopmentCallLimit,
	DataSourceProductionCallLimit,
} from "@maple/backend/platform/bindings"
import { WorkersAiGateway } from "../platform/WorkersAiHttpClient"
import { BoundAiClients } from "../worker/bindings"
import { makeChatSessionActivation, type ProposalApplier, type TurnRunner } from "./ChatSession"
import type { ApplyChatProposalInput } from "./apply-proposal"
import type { RunChatSessionTurnInput } from "./turn-runner"

const TENANT = encodeChatTurnTenant({
	orgId: "org_test" as ChatTurnTenant["orgId"],
	userId: "user_test" as ChatTurnTenant["userId"],
	roles: [],
	authMode: "self_hosted",
})

/** The clients the Worker bound, recording what reaches them: every limiter refuses, the queue accepts. */
const makeBoundClients = () => {
	const limited: Array<string> = []
	const queued: Array<unknown> = []
	const limiter = (name: string) => ({
		limit: (options: { readonly key: string }) =>
			Effect.sync(() => {
				limited.push(`${name}:${options.key}`)
				return { success: false }
			}),
	})
	const clients = {
		mcpToolsRateLimit: limiter("mcp"),
		dataSourceProductionCallLimit: limiter("production"),
		dataSourceDevelopmentCallLimit: limiter("development"),
		auditEvents: {
			raw: Effect.succeed({
				sendBatch: (messages: ReadonlyArray<{ readonly body: unknown }>) => {
					queued.push(...Arr.map(messages, (message) => message.body))
					return Promise.resolve()
				},
			}),
		},
	}
	// SAFETY: the ports read `limit` off a limiter and `raw.sendBatch` off the queue, and nothing else.
	const layer = Layer.succeed(BoundAiClients, clients as unknown as typeof BoundAiClients.Service)
	return { layer, limited, queued }
}

/** Alchemy's `SqlMigrations` captures the files at deploy; a test applies the same files directly. */
const activateChatSession = (ports?: { readonly apply: ProposalApplier; readonly run: TurnRunner }) =>
	Effect.flatMap(Cloudflare.DurableObjectState, (state) =>
		makeChatSessionActivation(
			Effect.succeed({
				apply: () => Effect.sync(() => applyChatSessionMigrations(state.raw.storage.sql)),
			}),
			ports,
		),
	)

/** One activation the way alchemy's Durable Object bridge performs it: the outer phase under the state, then the inner. */
const activateOn = (
	state: ReturnType<typeof makeFakeDurableObjectState>,
	options: {
		readonly clients?: ReturnType<typeof makeBoundClients>
		readonly ports?: { readonly apply: ProposalApplier; readonly run: TurnRunner }
	} = {},
) =>
	Effect.gen(function* () {
		// SAFETY: the fake carries the `storage.sql` and `waitUntil` the class reads, and nothing else.
		const raw = state as unknown as import("@cloudflare/workers-types").DurableObjectState
		const build = yield* activateChatSession(options.ports).pipe(
			Effect.provide([
				Layer.succeed(Cloudflare.DurableObjectState, Cloudflare.fromDurableObjectState(raw)),
				Layer.succeed(Cloudflare.WorkerEnvironment, {}),
				Layer.succeed(WorkersAiGateway, Option.none()),
				(options.clients ?? makeBoundClients()).layer,
			]),
		)
		return { rpc: yield* build, state }
	})

/** A fresh object per test, so no test reads another's events. */
const activate = () => activateOn(makeFakeDurableObjectState({ migrated: false }))

describe("the ChatSession Durable Object on alchemy's form", () => {
	it.effect("the outer phase touches no storage, so it can run against alchemy's plan-time mock", () =>
		Effect.gen(function* () {
			// alchemy evaluates the outer Effect at plan time with `{ storage: {} }` as the state.
			// SAFETY: that is alchemy's own mock, reproduced here.
			const mock = { storage: {} } as unknown as import("@cloudflare/workers-types").DurableObjectState
			const build = yield* activateChatSession().pipe(
				Effect.provide([
					Layer.succeed(Cloudflare.DurableObjectState, Cloudflare.fromDurableObjectState(mock)),
					Layer.succeed(Cloudflare.WorkerEnvironment, {}),
					Layer.succeed(WorkersAiGateway, Option.none()),
					makeBoundClients().layer,
				]),
			)
			assert.isTrue(Effect.isEffect(build))
		}),
	)

	it.effect("exposes the stub's surface over the session it built", () =>
		Effect.gen(function* () {
			const { rpc } = yield* activate()
			assert.strictEqual(yield* rpc.cursor(), 0)
			const seq = yield* rpc.append({ type: "user-message", id: "u1", text: "hello" })
			assert.strictEqual(seq, 1)
			assert.deepStrictEqual(
				Arr.map(yield* rpc.since(0), (event) => event.type),
				["user-message"],
			)
			assert.strictEqual(yield* rpc.running(), false)
			assert.strictEqual((yield* rpc.history()).length, 1)
		}),
	)

	it.effect("begins a turn over RPC and lets the class own it", () =>
		Effect.gen(function* () {
			const { rpc, state } = yield* activate()
			const begun = yield* rpc.beginTurn({
				sessionId: "org_test:tab",
				messageId: "m1",
				text: "why is checkout slow?",
				tenant: TENANT,
				origin: { kind: "app" },
			})
			assert.isDefined(begun)
			assert.strictEqual(yield* rpc.running(), true)
			// The turn was scheduled on the object's own context, not the caller's.
			// Two pieces of object work: the turn and the heartbeat alarm that keeps the object alive.
			assert.strictEqual(state.pending.length, 2)
			assert.lengthOf(state.alarms, 1)
			yield* rpc.abort("user")
			assert.strictEqual(yield* rpc.running(), false)
		}),
	)

	it.effect("brings a session table from before the late columns up to the baseline", () =>
		Effect.gen(function* () {
			const state = makeFakeDurableObjectState({ migrated: false })
			state.storage.sql.exec(
				"CREATE TABLE session (id INTEGER PRIMARY KEY CHECK (id = 1), running INTEGER NOT NULL DEFAULT 0)",
			)
			state.storage.sql.exec("INSERT INTO session (id, running) VALUES (1, 0)")
			const { rpc } = yield* activateOn(state)

			assert.strictEqual(yield* rpc.running(), false)
			const columns = Arr.map(
				state.storage.sql.exec("SELECT name FROM pragma_table_info('session')").toArray(),
				(row) => row.name,
			)
			assert.includeMembers(columns, [
				"running_since",
				"running_message_id",
				"running_input",
				"running_resumes",
			])
		}),
	)

	/** A turn or an approval builds its own runtime, so the Worker's limiters and queue are handed to it. */
	describe("hands the Worker's bound clients to the runtimes it starts", () => {
		const recordingPorts = () => {
			const runs: Array<RunChatSessionTurnInput> = []
			const applies: Array<ApplyChatProposalInput> = []
			return {
				runs,
				applies,
				ports: {
					run: (input: RunChatSessionTurnInput) => {
						runs.push(input)
						return Promise.resolve()
					},
					apply: (input: ApplyChatProposalInput) => {
						applies.push(input)
						return Promise.resolve({ output: "Created alert rule ar_1.", isError: false })
					},
				},
			}
		}

		it.effect("a turn spends the data-source call budget on the bound limiters", () =>
			Effect.gen(function* () {
				const clients = makeBoundClients()
				const recorded = recordingPorts()
				const { rpc, state } = yield* activateOn(makeFakeDurableObjectState({ migrated: false }), {
					clients,
					ports: recorded.ports,
				})
				yield* rpc.beginTurn({
					sessionId: "org_test:tab",
					messageId: "m1",
					text: "how many users signed up today?",
					tenant: TENANT,
					origin: { kind: "app" },
				})
				yield* Effect.promise(() => Promise.all(state.pending))

				const bindingPorts = recorded.runs[0]?.bindingPorts
				assert.isDefined(bindingPorts)
				if (bindingPorts === undefined) return
				const outcomes = yield* Effect.gen(function* () {
					const production = yield* DataSourceProductionCallLimit
					const development = yield* DataSourceDevelopmentCallLimit
					return [yield* production.limit("src_1"), yield* development.limit("src_2")]
				}).pipe(Effect.provide(bindingPorts))
				assert.deepStrictEqual(outcomes, [{ success: false }, { success: false }])
				assert.deepStrictEqual(clients.limited, ["production:src_1", "development:src_2"])
			}),
		)

		it.effect("an approved change queues its audit entry on the bound queue", () =>
			Effect.gen(function* () {
				const clients = makeBoundClients()
				const recorded = recordingPorts()
				const { rpc } = yield* activateOn(makeFakeDurableObjectState({ migrated: false }), {
					clients,
					ports: recorded.ports,
				})
				yield* rpc.append({ type: "turn-start", messageId: "a1" })
				yield* rpc.append({
					type: "tool-call",
					messageId: "a1",
					callId: "call_9",
					name: "create_alert_rule",
					input: { name: "checkout p95" },
					proposed: true,
				})
				yield* rpc.append({ type: "turn-end", messageId: "a1", reason: "stop" })
				yield* rpc.settleProposal({
					sessionId: "org_test:tab",
					toolCallId: "call_9",
					decision: "approve",
					approver: { kind: "app" },
					tenant: TENANT,
				})

				const bindingPorts = recorded.applies[0]?.bindingPorts
				assert.isDefined(bindingPorts)
				if (bindingPorts === undefined) return
				yield* Effect.gen(function* () {
					const queue = yield* AuditEventsQueueProducer
					yield* queue.sendBatch([{ body: { action: "alert_rule.create" } }])
				}).pipe(Effect.provide(bindingPorts))
				assert.deepStrictEqual(clients.queued, [{ action: "alert_rule.create" }])
			}),
		)
	})
})
