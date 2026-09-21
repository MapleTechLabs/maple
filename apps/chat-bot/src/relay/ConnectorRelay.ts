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
 * Deliberately storage-free. The object holds nothing between events: the conversation's durable
 * state is the chat session's, the claim on a running turn is the chat session's too, and an
 * object evicted mid-turn leaves a message holding the last thing the turn had said — the session
 * ends the turn on its own heartbeat either way. Resuming the rendering would mean persisting
 * every message the driver posted, which is a feature to add when an eviction is seen, not before.
 */
import type { InboundEvent } from "@maple/chat-platform"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"

/** What this object reads off its Durable Object state. */
interface ConnectorRelayState {
	readonly storage: {
		setAlarm(scheduledTime: number): Promise<void>
	}
	waitUntil(promise: Promise<unknown>): void
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

/** How long a workspace that nobody has linked goes unmentioned in this conversation. */
const UNLINKED_NOTICE_INTERVAL_MS = 60 * 60 * 1000

export class ConnectorRelay {
	/** How many events this activation is still working on. Zero means the alarm may stop. */
	private live = 0
	private unlinkedNoticeAt: number | undefined

	constructor(
		private readonly ctx: ConnectorRelayState,
		private readonly env: Record<string, unknown>,
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

	async alarm(): Promise<void> {
		if (this.live > 0) this.armKeepAlive()
	}

	private armKeepAlive(): void {
		this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + KEEP_ALIVE_MS).catch(() => undefined))
	}

	/**
	 * Everything below this line is behind a dynamic import: it reaches the connector registry, the
	 * agent's wire contract and the database, and none of that should be evaluated when Cloudflare
	 * validates the uploaded script.
	 */
	private async run(event: InboundEvent): Promise<void> {
		try {
			const { runInboundEvent } = await import("./run.ts")
			await runInboundEvent(
				{ env: this.env, announceUnlinked: Effect.sync(() => this.takeUnlinkedNotice()) },
				event,
			)
		} catch (cause) {
			console.error("[chat-bot.relay] event failed", cause)
		} finally {
			this.live -= 1
		}
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
