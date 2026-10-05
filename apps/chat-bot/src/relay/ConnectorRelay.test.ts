/**
 * The relay object's one durable fact: which conversations the bot opened itself.
 *
 * Worth its own test because the two things that can go wrong here are invisible in review. The
 * marker is keyed by CONVERSATION, not held as a flag on the object, or the first thread the bot
 * opens in a channel would speak for every thread in it on a platform that addresses threads inside
 * their channel. And it is written to the object that will handle the conversation's LATER
 * messages, which is not the object handling the message that opened it — locally when they are the
 * same object, because a Durable Object calling itself deadlocks behind its own input gate.
 */
import type { ChatConversation, InboundMessage } from "@maple/chat-platform"
import { chatConnectorId } from "@maple/chat-platform"
import { ChatConversationKey } from "@maple/domain/chat-session"
import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
	ConnectorRelay,
	type ConnectorRelayLedger,
	type ConnectorRelayRuntime,
	ConnectorRelayStorageError,
} from "./ConnectorRelay.ts"
import { decodeRelayTurnCheckpoint, type RelayTurnCheckpoint, type SettleOutcome } from "./settle.ts"
import type { RelayHost } from "./run.ts"

/**
 * The real heavy half, with every settle it is asked for recorded — and, given them, stand-ins for
 * the turn a delivered event runs and for what a settle answers.
 */
const heavy = (stand?: {
	readonly event?: (host: RelayHost) => Promise<void>
	readonly settle?: SettleOutcome
}) => {
	const settled: Array<unknown> = []
	const load = async (): Promise<ConnectorRelayRuntime> => {
		const actual = await import("./run.ts")
		return {
			runInboundEvent: (host, inbound) =>
				stand?.event === undefined ? actual.runInboundEvent(host, inbound) : stand.event(host),
			settleInboundTurn: (host, stored) => {
				settled.push(stored)
				return stand?.settle === undefined
					? actual.settleInboundTurn(host, stored)
					: Promise.resolve(stand.settle)
			},
		}
	}
	return { settled, load }
}

const TESTCHAT = chatConnectorId("testchat")
const conversationKey = Schema.decodeSync(ChatConversationKey)

const message: InboundMessage = {
	type: "message",
	connector: TESTCHAT,
	workspaceId: "workspace-1",
	channelId: "channel-1",
	messageId: "message-1",
	author: { id: "author-1", displayName: "Ada", isBot: false },
	text: "why is checkout slow?",
	mentionsBot: true,
}

/** A conversation the connector opened for that message, at whatever address it gave it. */
const conversation = (channelId: string, key = channelId): ChatConversation => ({
	conversationKey: conversationKey(key),
	target: { workspaceId: message.workspaceId, channelId },
	opened: true,
})

/**
 * One object's storage and its pending jobs — enough of the platform to drive the class. The
 * ledger keeps checkpoints in the same store, as the isolate's does; a test runs a job by calling
 * `turnDue` / `keepAliveDue` itself.
 */
const objectState = () => {
	const stored = new Map<string, unknown>()
	const pending: Array<Promise<unknown>> = []
	/** Pending turn jobs by checkpoint key, and how often each was scheduled. */
	const turnJobs = new Map<string, number>()
	const keepAlive = { scheduled: 0 }
	const schedule = (key: string) => turnJobs.set(key, (turnJobs.get(key) ?? 0) + 1)
	const ledger: ConnectorRelayLedger = {
		record: (key, checkpoint) =>
			Effect.sync(() => {
				stored.set(key, checkpoint)
				schedule(key)
			}),
		forget: (key) =>
			Effect.sync(() => {
				stored.delete(key)
				turnJobs.delete(key)
			}),
		read: (key) => Effect.sync(() => stored.get(key)),
		revisit: (key) => Effect.sync(() => void (stored.has(key) && schedule(key))),
		keepAlive: Effect.sync(() => void (keepAlive.scheduled += 1)),
	}
	return {
		stored,
		pending,
		turnJobs,
		keepAlive,
		ledger,
		waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
		storage: {
			get: <A>(key: string) => Promise.resolve(stored.get(key) as A | undefined),
			put: (key: string, value: boolean) => {
				stored.set(key, value)
				return Promise.resolve()
			},
		},
	}
}

/** A relay over `state`, with the heavy half `load` stands in for. */
const relayOn = (state: ReturnType<typeof objectState>, load?: () => Promise<ConnectorRelayRuntime>) =>
	new ConnectorRelay(state, {}, state.ledger, load)

/**
 * A deployment of relay objects, addressed the way the Worker env addresses them.
 *
 * `ports` is what the object hands the turn — the same two Effects `RelayPorts` declares — so a
 * test drives the real routing rather than a description of it.
 */
const deployment = () => {
	const objects = new Map<string, ReturnType<typeof objectState>>()
	const env: Record<string, unknown> = {}
	const relays = new Map<string, ConnectorRelay>()
	const at = (name: string) => {
		const existing = relays.get(name)
		if (existing !== undefined) return existing
		const state = objectState()
		objects.set(name, state)
		const relay = new ConnectorRelay(state, env, state.ledger)
		relays.set(name, relay)
		return relay
	}
	// What workerd hands back for an RPC call: the method's Effect, run on the target object.
	env.ConnectorRelay = {
		idFromName: (name: string) => name,
		get: (name: unknown) => ({
			remember: (conversationKey: string) =>
				Effect.runPromise(at(String(name)).remember(conversationKey)),
		}),
	}
	return {
		objects,
		/** The ports the object handling `event` builds for the turn it runs. */
		ports: (name: string, event: InboundMessage) => at(name).relayPorts(event),
	}
}

describe("remembering the conversations the bot opened", () => {
	it("records a thread the platform gave its own address on the object that will answer in it", () =>
		Effect.gen(function* () {
			const fleet = deployment()
			// The mention arrived in the channel, and the connector opened `thread_7` for it.
			const ports = fleet.ports("testchat:workspace-1:channel-1", message)

			yield* ports.rememberConversation(conversation("thread_7"))

			// Not on the channel's object, where nothing will ever ask about it…
			expect([...(fleet.objects.get("testchat:workspace-1:channel-1")?.stored ?? [])]).toEqual([])
			// …but on the thread's, which is where the follow-up will arrive.
			expect([...(fleet.objects.get("testchat:workspace-1:thread_7")?.stored ?? [])]).toEqual([
				["opened:thread_7", true],
			])
		}).pipe(Effect.runPromise))

	it("answers for the conversation that was recorded, and only that one", () =>
		Effect.gen(function* () {
			const fleet = deployment()
			const name = "testchat:workspace-1:channel-1"
			// A platform that puts a thread INSIDE a channel: both conversations are this object's,
			// so a flag rather than a key would make the first one speak for the second.
			const here = { ...message, channelId: "channel-1" }
			const ports = fleet.ports(name, here)

			yield* ports.rememberConversation({
				conversationKey: conversationKey("thread_a"),
				target: { workspaceId: "workspace-1", channelId: "channel-1", threadId: "thread_a" },
				opened: true,
			})

			expect(yield* ports.ownsConversation(conversationKey("thread_a"))).toBe(true)
			expect(yield* ports.ownsConversation(conversationKey("thread_b"))).toBe(false)
		}).pipe(Effect.runPromise))

	it("reports a write that did not land, rather than losing it to a console", () =>
		Effect.gen(function* () {
			// The turn logs this and answers anyway. It is still the one failure that makes a bot
			// answer mentions here and nothing else, so it has to reach the turn to be logged there.
			const broken = objectState()
			broken.storage.put = () => Promise.reject(new Error("storage unavailable"))
			const relay = relayOn(broken)
			const here = { ...message, channelId: "channel-1" }

			const error = yield* Effect.flip(
				relay.relayPorts(here).rememberConversation(conversation("channel-1", "thread_a")),
			)

			expect(error._tag).toBe("@maple/chat-bot/ConversationNotRecorded")
			expect(error.conversationKey).toBe("thread_a")
		}).pipe(Effect.runPromise))

	it("survives a deployment that binds no relay namespace at all", () =>
		Effect.gen(function* () {
			// Nothing to write to, and the turn this rides on is somebody's question: the answer must
			// still be given, at the cost of the follow-ups after it.
			const relay = relayOn(objectState())
			const ports = relay.relayPorts(message)

			yield* ports.rememberConversation(conversation("thread_7"))

			expect(yield* ports.ownsConversation(conversationKey("thread_7"))).toBe(false)
		}).pipe(Effect.runPromise))
})

/** A turn's checkpoint as the relay writes it. */
const checkpoint = (): RelayTurnCheckpoint =>
	Option.getOrThrow(
		decodeRelayTurnCheckpoint({
			connector: TESTCHAT,
			sessionId: "org_1:bot-testchat-thread_7",
			turnMessageId: "a1",
			cursor: 0,
			target: { workspaceId: "workspace-1", channelId: "thread_7" },
			messages: [{ target: { workspaceId: "workspace-1", channelId: "thread_7" }, messageId: "m1" }],
			recordedAt: 0,
		}),
	)
const TURN_KEY = "turn:org_1:bot-testchat-thread_7:a1"

describe("turn jobs", () => {
	it("does nothing for a job whose turn was already forgotten", async () => {
		const state = objectState()
		state.stored.set("opened:thread_7", true)
		await Effect.runPromise(relayOn(state).turnDue(TURN_KEY))

		expect(state.pending).toEqual([])
		expect([...state.turnJobs]).toEqual([])
		expect([...state.stored]).toEqual([["opened:thread_7", true]])
	})

	it("only revisits a turn this activation is still relaying, and drops it and its job when the turn ends", async () => {
		const state = objectState()
		let finish = () => {}
		const finished = new Promise<void>((resolve) => {
			finish = resolve
		})
		let recordedTurn = () => {}
		const recorded = new Promise<void>((resolve) => {
			recordedTurn = resolve
		})
		const run = heavy({
			event: async (host) => {
				await Effect.runPromise(host.recordTurn(checkpoint()))
				recordedTurn()
				await finished
			},
		})
		const relay = relayOn(state, run.load)

		await Effect.runPromise(relay.deliver(message))
		await recorded
		expect([...state.stored.keys()]).toEqual([TURN_KEY])
		// The job lands mid-turn: the checkpoint is this activation's own, not an orphan.
		await Effect.runPromise(relay.turnDue(TURN_KEY))
		expect(state.turnJobs.get(TURN_KEY)).toBe(2)

		finish()
		await Promise.all(state.pending)
		expect(run.settled).toEqual([])
		expect([...state.stored]).toEqual([])
		expect([...state.turnJobs]).toEqual([])
	})

	it("settles an evicted turn, and drops it and its job once settled", async () => {
		const state = objectState()
		const run = heavy({ settle: "done" })
		state.stored.set(TURN_KEY, checkpoint())
		await Effect.runPromise(relayOn(state, run.load).turnDue(TURN_KEY))

		expect(run.settled).toEqual([checkpoint()])
		expect([...state.stored]).toEqual([])
		expect([...state.turnJobs]).toEqual([])
	})

	it("keeps a turn the session is still running, and comes back for it", async () => {
		const state = objectState()
		const run = heavy({ settle: "pending" })
		state.stored.set(TURN_KEY, checkpoint())
		const relay = relayOn(state, run.load)

		await Effect.runPromise(relay.turnDue(TURN_KEY))
		await Effect.runPromise(relay.turnDue(TURN_KEY))

		expect(run.settled).toEqual([checkpoint(), checkpoint()])
		expect([...state.stored.keys()]).toEqual([TURN_KEY])
		expect(state.turnJobs.get(TURN_KEY)).toBe(2)
	})

	it("drops a turn checkpoint it can no longer read", async () => {
		// One an older build wrote: dropped rather than thrown on.
		const state = objectState()
		state.stored.set(TURN_KEY, { sessionId: "org_1:bot-testchat-thread_7" })
		await Effect.runPromise(relayOn(state).turnDue(TURN_KEY))

		expect([...state.stored]).toEqual([])
	})
})

describe("the keep-alive", () => {
	it("is not pushed back, however busy the conversation", async () => {
		// Events under 30s apart would otherwise postpone it indefinitely.
		const state = objectState()
		const relay = relayOn(state, heavy({ event: () => Promise.resolve() }).load)

		await Effect.runPromise(relay.deliver(message))
		await Effect.runPromise(relay.deliver(message))
		await Promise.all(state.pending)

		expect(state.keepAlive.scheduled).toBe(1)
	})

	it("re-arms while a turn runs, lapses once none does, and arms again for the next event", async () => {
		const state = objectState()
		let finish = () => {}
		const finished = new Promise<void>((resolve) => {
			finish = resolve
		})
		const relay = relayOn(state, heavy({ event: () => finished }).load)

		await Effect.runPromise(relay.deliver(message))
		await Effect.runPromise(relay.keepAliveDue())
		expect(state.keepAlive.scheduled).toBe(2)

		finish()
		await Promise.all(state.pending)
		await Effect.runPromise(relay.keepAliveDue())
		expect(state.keepAlive.scheduled).toBe(2)

		await Effect.runPromise(relay.deliver(message))
		expect(state.keepAlive.scheduled).toBe(3)
	})

	it("arms again on the next event after a schedule that failed", async () => {
		const state = objectState()
		const relay = relayOn(state, heavy({ event: () => Promise.resolve() }).load)
		const working = state.ledger.keepAlive
		Object.assign(state.ledger, {
			keepAlive: Effect.fail(
				new ConnectorRelayStorageError({ operation: "keepAlive", message: "down", cause: undefined }),
			),
		})

		await Effect.runPromise(relay.deliver(message))
		await Promise.all(state.pending)
		Object.assign(state.ledger, { keepAlive: working })
		await Effect.runPromise(relay.deliver(message))
		await Promise.all(state.pending)

		expect(state.keepAlive.scheduled).toBe(1)
	})
})

describe("a job racing the end of its turn", () => {
	it("does not settle a turn that finished after the job read its checkpoint", async () => {
		const state = objectState()
		let finish = () => {}
		const finished = new Promise<void>((resolve) => {
			finish = resolve
		})
		let recordedTurn = () => {}
		const recorded = new Promise<void>((resolve) => {
			recordedTurn = resolve
		})
		const run = heavy({
			event: async (host) => {
				await Effect.runPromise(host.recordTurn(checkpoint()))
				recordedTurn()
				await finished
			},
		})
		const relay = relayOn(state, run.load)
		await Effect.runPromise(relay.deliver(message))
		await recorded

		// The job's read lands, then the turn ends before it decides.
		const read = state.ledger.read
		Object.assign(state.ledger, {
			read: (key: string) =>
				read(key).pipe(
					Effect.tap(() =>
						Effect.promise(async () => {
							finish()
							await Promise.all(state.pending)
						}),
					),
				),
		})
		await Effect.runPromise(relay.turnDue(TURN_KEY))

		expect(run.settled).toEqual([])
		expect([...state.stored]).toEqual([])
		expect([...state.turnJobs]).toEqual([])
	})
})
