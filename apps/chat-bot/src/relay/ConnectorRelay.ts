/**
 * `ConnectorRelay` — one Durable Object per conversation, which owns everything an inbound event
 * causes: resolving the org, claiming the turn, and streaming the answer back for as long as it
 * takes.
 *
 * It exists because of where the alternative would run. A socket connector has exactly ONE
 * `ConnectorSocket` for the whole deployment — every org, every workspace, one object holding one
 * connection — and its steps run in arrival order, so a turn relayed there would either block the
 * next frame behind a minutes-long model run or pile every concurrent turn in the system into the
 * object that must not fall over. Addressing a relay by conversation gives each turn its own
 * object, its own memory and its own failure, and leaves the socket doing nothing but the socket.
 *
 * It is also what keeps the I/O honest: a relayed turn's stream, its edits and its database call
 * all happen inside one Durable Object's own context. No promise crosses back into the request
 * that delivered the event — a shared one resumed from another request's I/O context is how this
 * codebase has broken workerd before.
 *
 * It holds two things between events: which conversations the bot opened itself, which is what
 * lets a message in one of them be answered without mentioning the bot, and a checkpoint of the
 * messages each relayed turn has posted, so a turn whose object was evicted still gets its final
 * answer (`./settle.ts`). Everything else — the transcript, the claim on a running turn — is the
 * chat session's.
 */
import type { ChatConversation, InboundEvent } from "@maple/chat-platform"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import { ConversationNotRecorded } from "./conversation.ts"
import type { RelayTurnCheckpoint } from "./settle.ts"
import { connectorConversationRelayName, connectorRelayByName } from "./stub.ts"

/** What this object reads off its Durable Object state. */
interface ConnectorRelayState {
	readonly storage: {
		getAlarm(): Promise<number | null>
		setAlarm(scheduledTime: number): Promise<void>
		get<A>(key: string): Promise<A | undefined>
		put(key: string, value: boolean | RelayTurnCheckpoint): Promise<void>
		delete(key: string): Promise<boolean>
		list(options: { prefix: string }): Promise<Map<string, unknown>>
	}
	waitUntil(promise: Promise<unknown>): void
}

/**
 * Where the one durable fact lives, under the conversation it is about.
 *
 * Keyed rather than a bare flag because an object is addressed by CHANNEL: a platform that models
 * a thread as a coordinate inside a channel puts every one of that channel's threads on this
 * object, and a flag would make the first thread the bot opened speak for all of them.
 */
const openedKey = (conversationKey: string): string => `opened:${conversationKey}`

/** One checkpoint per turn: a channel whose threads are conversations can relay several at once. */
const TURN_PREFIX = "turn:"
const turnKey = (checkpoint: RelayTurnCheckpoint): string =>
	`${TURN_PREFIX}${checkpoint.sessionId}:${checkpoint.turnMessageId}`

/**
 * The half of a turn's ports that the relay OBJECT answers, rather than the database or the
 * platform.
 *
 * Declared here, structurally, rather than imported from `./turn.ts`: that module reaches the
 * connector registry and the database, and this file is evaluated when Cloudflare validates the
 * uploaded script. `run.ts` is where the two halves meet.
 */
export interface ConnectorRelayPorts {
	readonly announceUnlinked: Effect.Effect<boolean>
	readonly ownsConversation: (conversationKey: string) => Effect.Effect<boolean>
	readonly rememberConversation: (
		conversation: ChatConversation,
	) => Effect.Effect<void, ConversationNotRecorded>
}

/**
 * How often a relaying object re-arms its alarm.
 *
 * An outbound fetch never keeps a Durable Object alive and an object with no incoming event is
 * evicted inside a couple of minutes, so a turn nobody is streaming FROM this object would be cut
 * off mid-answer. The alarm is that incoming event, and it is the same 30 seconds the chat session
 * itself uses for the same reason.
 */
const KEEP_ALIVE_MS = 30 * 1000

/** The heavy half, loaded on first use (see `run`); a parameter so a test can stand in for it. */
export type ConnectorRelayRuntime = Pick<typeof import("./run.ts"), "runInboundEvent" | "settleInboundTurn">

const loadRuntime = (): Promise<ConnectorRelayRuntime> => import("./run.ts")

/** How long a workspace that nobody has linked goes unmentioned in this conversation. */
const UNLINKED_NOTICE_INTERVAL_MS = 60 * 60 * 1000

export class ConnectorRelay {
	/** How many events this activation is still working on. Zero means the alarm may stop. */
	private live = 0
	/** Checkpoints this activation is relaying; one in storage but not here is an evicted turn's. */
	private readonly relaying = new Set<string>()
	private unlinkedNoticeAt: number | undefined

	constructor(
		private readonly ctx: ConnectorRelayState,
		private readonly env: Record<string, unknown>,
		private readonly runtime: () => Promise<ConnectorRelayRuntime> = loadRuntime,
	) {}

	/**
	 * Take the event and answer at once.
	 *
	 * The caller is the socket, which must be back to reading frames in milliseconds; the work runs
	 * on this object's own context and outlives the call, exactly as a chat turn outlives the
	 * request that begins it.
	 */
	async deliver(event: InboundEvent): Promise<void> {
		this.live += 1
		this.armKeepAlive()
		this.ctx.waitUntil(this.run(event))
	}

	/**
	 * The keep-alive, and the settle of turns an evicted activation left behind. It keeps firing while
	 * any checkpoint is left, which is how a turn the session is still running gets settled later.
	 */
	async alarm(): Promise<void> {
		const recorded = await this.ctx.storage
			.list({ prefix: TURN_PREFIX })
			.catch(() => new Map<string, unknown>())
		for (const [key, checkpoint] of recorded) {
			if (this.relaying.has(key)) continue
			this.live += 1
			this.relaying.add(key)
			this.ctx.waitUntil(this.settle(key, checkpoint))
		}
		if (this.live > 0 || recorded.size > 0) this.armKeepAlive()
	}

	/**
	 * What this object gives the turn it is running: the three answers only the object can give.
	 *
	 * Named and public so it can be driven without the heavy half — everything the turn itself
	 * needs is behind a dynamic import, and these are the part of it this class owns.
	 */
	relayPorts(event: InboundEvent): ConnectorRelayPorts {
		return {
			announceUnlinked: Effect.sync(() => this.takeUnlinkedNotice()),
			ownsConversation: (conversationKey) => Effect.promise(() => this.opened(conversationKey)),
			rememberConversation: (conversation) =>
				Effect.tryPromise({
					catch: (cause) =>
						new ConversationNotRecorded({
							conversationKey: conversation.conversationKey,
							message: "The conversation's relay object did not record that the bot opened it",
							cause,
						}),
					try: () => this.rememberOpened(event, conversation),
				}),
		}
	}

	/** Called on the conversation's own object, by whichever object opened it. */
	async remember(conversationKey: string): Promise<void> {
		await this.ctx.storage.put(openedKey(conversationKey), true)
	}

	/** A store that cannot be read answers "not ours", which is mention-only — never a failed event. */
	private async opened(conversationKey: string): Promise<boolean> {
		const marker = await this.ctx.storage.get<boolean>(openedKey(conversationKey)).catch(() => undefined)
		return marker === true
	}

	/**
	 * Record a conversation the bot just opened, wherever it belongs.
	 *
	 * A conversation the platform gave its own address — a thread that is a channel — is another
	 * object's, and is reached by RPC. One that lives inside the channel this event arrived in is
	 * this object's own, and writing it here rather than through a stub is not an optimization: a
	 * Durable Object calling itself is how a request deadlocks behind its own input gate.
	 *
	 * A write that fails reaches the turn as `ConversationNotRecorded` rather than being reported
	 * here: it costs the follow-ups AFTER this answer and must never cost the answer, and the turn
	 * is where a log carries the org, the session and the span it belongs to.
	 */
	private async rememberOpened(event: InboundEvent, conversation: ChatConversation): Promise<void> {
		const here = "channelId" in event ? event.channelId : undefined
		const name = connectorConversationRelayName(event.connector, conversation.target)
		await (here === conversation.target.channelId
			? this.remember(conversation.conversationKey)
			: connectorRelayByName(this.env, name)?.remember(conversation.conversationKey))
	}

	/** A pending alarm is kept, not pushed back: a busy conversation would postpone it forever. */
	private armKeepAlive(): void {
		this.ctx.waitUntil(
			this.ctx.storage
				.getAlarm()
				.then((pending) =>
					pending === null ? this.ctx.storage.setAlarm(Date.now() + KEEP_ALIVE_MS) : undefined,
				)
				.catch(() => undefined),
		)
	}

	/**
	 * Everything below this line is behind a dynamic import: it reaches the connector registry, the
	 * agent's wire contract and the database, and none of that should be evaluated when Cloudflare
	 * validates the uploaded script.
	 */
	private async run(event: InboundEvent): Promise<void> {
		// The run that recorded a checkpoint is the one that clears it, whatever ended the turn.
		let recorded: string | undefined
		const recordTurn = (checkpoint: RelayTurnCheckpoint) =>
			Effect.suspend(() => {
				recorded = turnKey(checkpoint)
				return this.recordTurn(checkpoint)
			})
		try {
			const { runInboundEvent } = await this.runtime()
			await runInboundEvent({ env: this.env, ...this.relayPorts(event), recordTurn }, event)
		} catch (cause) {
			console.error("[chat-bot.relay] event failed", cause)
		} finally {
			if (recorded !== undefined) await this.forgetTurn(recorded)
			this.live -= 1
		}
	}

	/** Kept only while the session is still running the turn; cleared however else it ends. */
	private async settle(key: string, checkpoint: unknown): Promise<void> {
		let outcome = "done"
		try {
			const { settleInboundTurn } = await this.runtime()
			outcome = await settleInboundTurn(
				{ env: this.env, recordTurn: (next) => this.recordTurn(next) },
				checkpoint,
			)
		} catch (cause) {
			console.error("[chat-bot.relay] settle failed", cause)
		} finally {
			if (outcome === "done") await this.forgetTurn(key)
			else this.relaying.delete(key)
			this.live -= 1
		}
	}

	/** Marked before the write, so an alarm meanwhile does not take a live turn for an evicted one. */
	private recordTurn(checkpoint: RelayTurnCheckpoint): Effect.Effect<void> {
		const key = turnKey(checkpoint)
		return Effect.promise(() => {
			this.relaying.add(key)
			return this.ctx.storage.put(key, checkpoint).catch(() => undefined)
		})
	}

	/** Deleted before it is released, for the same reason. */
	private async forgetTurn(key: string): Promise<void> {
		await this.ctx.storage.delete(key).catch(() => undefined)
		this.relaying.delete(key)
	}

	/**
	 * Whether this conversation should be told its workspace is not linked, and record that it was.
	 *
	 * In memory rather than in storage: the point is not to repeat it on every mention in a busy
	 * channel, and an evicted object costing one extra notice an hour is cheaper than a write per
	 * mention.
	 */
	private takeUnlinkedNotice(): boolean {
		const now = Date.now()
		if (
			this.unlinkedNoticeAt !== undefined &&
			now - this.unlinkedNoticeAt < UNLINKED_NOTICE_INTERVAL_MS
		) {
			return false
		}
		this.unlinkedNoticeAt = now
		return true
	}
}

export interface ConnectorRelayApi {
	readonly deliver: (event: InboundEvent) => Effect.Effect<void>
	readonly alarm: () => Effect.Effect<void>
	readonly remember: (conversationKey: string) => Effect.Effect<void>
}

/**
 * One activation, in alchemy's two phases: the outer Effect resolves the state and env — it also
 * runs at plan time against a mock state, so it must not touch storage — and the inner one returns
 * the object's methods as Effects, which alchemy's bridge runs per RPC call.
 */
export const activateConnectorRelay = Effect.map(
	Effect.all([Cloudflare.DurableObjectState, Cloudflare.WorkerEnvironment]),
	([state, env]) =>
		Effect.sync(() => {
			const relay = new ConnectorRelay(state.raw, env)
			return {
				deliver: (event) => Effect.promise(() => relay.deliver(event)),
				alarm: () => Effect.promise(() => relay.alarm()),
				remember: (conversationKey) => Effect.promise(() => relay.remember(conversationKey)),
			} satisfies ConnectorRelayApi
		}),
)

/** The Durable Object: one per conversation, hosted by this Worker. */
export class ConnectorRelayObject extends Cloudflare.DurableObject<ConnectorRelayObject, ConnectorRelayApi>()(
	"ConnectorRelay",
) {}

// The activation's requirements are named rather than inferred, exactly as `ConnectorSocket`'s
// are: `.make` discharges `DurableObjectServices` through its own `Exclude`, while inference would
// widen them into the layer's requirements and surface them in `alchemy.run.ts`.
export const ConnectorRelayLive = ConnectorRelayObject.make<
	Cloudflare.DurableObjectState | Cloudflare.WorkerEnvironment
>(activateConnectorRelay)
