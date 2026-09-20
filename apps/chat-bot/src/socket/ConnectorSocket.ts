/**
 * `ConnectorSocket` — one Durable Object per socket-ingress connector, holding
 * that connector's single long-lived connection.
 *
 * It is generic on purpose. It owns a socket, a timer and a little storage, and
 * every decision about what to write, what an incoming frame meant and when to
 * give up belongs to the connector's own state machine. Adding a platform that
 * also needs a socket adds a directory to `@maple/chat-platform`, not a second
 * Durable Object.
 *
 * **It stays resident, and that is the cost of the feature.** Hibernation only
 * covers sockets the platform hands the object (`state.acceptWebSocket`); a
 * socket the object dials out itself keeps the object in memory for as long as
 * it is open. One resident object per socket connector is what a mention
 * costs — a chat platform that delivers events by webhook needs none of this,
 * which is why the ingress contract has two kinds.
 *
 * What one step of a connector's protocol CAUSES lives in `./driver.ts`, where a
 * fake connector drives it without workerd. What is left here is the socket, the
 * alarm and the storage keys. The lifecycle this class owns on top of that —
 * when to dial, when to back off, how long a fatal directive holds — is not
 * covered by a test today; it needs a fake Durable Object state, which is worth
 * building the first time one of these rules changes.
 *
 * All socket I/O happens inside this object: the socket is created here, its
 * handlers run here under the object's own `waitUntil`, and no promise crosses
 * back into whichever request asked for the connection. A shared promise
 * resolved from another request's I/O context is how this codebase has broken
 * workerd before.
 */
import type { ChatConnector, ChatConnectorId, ConnectorConfig, SocketDirective, SocketIngress, SocketStep } from "@maple/chat-platform"
import { connectors } from "@maple/chat-platform/connectors"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { resolveConnectorConfig } from "../config.ts"
import { InboundHandler } from "../inbound.ts"
import { applyStep, reconnectDelayMs } from "./driver.ts"

/** What this object reads off its Durable Object state. */
interface ConnectorSocketState {
	readonly storage: {
		get<T>(key: string): Promise<T | undefined>
		put<T>(key: string, value: T): Promise<void>
		delete(key: string): Promise<boolean>
		setAlarm(scheduledTime: number): Promise<void>
	}
	waitUntil(promise: Promise<unknown>): void
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

/**
 * Storage keys. `connectorId` is here because a Durable Object cannot recover
 * its own name, and the alarm has to know which connector it is waking up for.
 */
const KEY = {
	connectorId: "connectorId",
	/** The connector's own state, opaque to this object. */
	protocol: "protocol",
	/** When the connector last asked to be called back. */
	heartbeatAt: "heartbeatAt",
	/** Not before this instant, after a failed connection. */
	reconnectAt: "reconnectAt",
	/** Set by a fatal directive; nothing is attempted until it passes. */
	stoppedUntil: "stoppedUntil",
	attempt: "attempt",
} as const

/**
 * The alarm is also a watchdog. Even with no heartbeat due and no reconnect
 * pending it fires every minute, which is what brings the connection back after
 * the object is evicted or a deploy replaces it.
 */
const WATCHDOG_MS = 60_000

/** Never schedule an alarm closer than this, so a misbehaving step cannot spin. */
const MIN_ALARM_MS = 1_000

/** A connection that stayed up this long counts as established, and resets the backoff. */
const ESTABLISHED_MS = 60_000

/**
 * How long a fatal directive holds the connector down.
 *
 * A fatal close is a configuration problem — a rejected token, an intent the
 * application was never granted — so retrying it in seconds is a loop against
 * someone else's rate limiter. It is not permanent either: once the credential
 * is fixed, nobody should have to know that a Durable Object is holding a flag.
 * Four attempts a day is a signal in the logs rather than a flood, and it heals
 * itself.
 */
const STOP_RETRY_MS = 6 * 60 * 60 * 1_000

/** Close code for a directive that is not a reconnect: an ordinary, final close. */
const NORMAL_CLOSE = 1_000

/** The services one step needs. Rebuilt per step, and both are a value each. */
const StepLayer = Layer.mergeAll(FetchHttpClient.layer, InboundHandler.layer)

/**
 * The frame, if it is one this host can carry.
 *
 * The socket contract is text frames: a binary one belongs to an encoding the
 * connector did not ask for, and passing it on as a string would corrupt it.
 */
// BOUNDARY: a socket message's payload, narrowed here before it reaches a connector.
const textFrame = (data: unknown): string | undefined => (typeof data === "string" ? data : undefined)

/**
 * The URL to dial, if it is one this host will carry a credential over.
 *
 * Two things are being refused. A connector's connect URL is wire-influenced —
 * a resumable session's host comes back from the platform — and `new WebSocket`
 * THROWS on a URL it cannot parse; thrown inside `blockConcurrencyWhile` that
 * resets the object, and the alarm would bring it straight back to the same
 * value, so parsing here turns a bad URL into one backed-off reconnect rather
 * than a reset loop.
 *
 * And `wss:` only. Every socket connector authenticates over its connection —
 * that is what its `requiredConfig` secrets are for — so a `ws:` URL arriving
 * in persisted state would put a token on the wire in the clear. A connector
 * that genuinely needs plaintext should have to argue for it here.
 */
const socketUrl = (url: string): string | undefined => {
	if (!URL.canParse(url)) return undefined
	return new URL(url).protocol === "wss:" ? url : undefined
}

interface ResolvedConnector {
	readonly connector: ChatConnector
	readonly ingress: SocketIngress
	readonly config: ConnectorConfig
}

/** One step of the connector's protocol, named by which input produced it. */
type RunStep = (
	ingress: SocketIngress,
	state: string,
	now: number,
	config: ConnectorConfig,
) => SocketStep<string>

export class ConnectorSocket {
	private socket: WebSocket | undefined
	/**
	 * Which connection the object is on.
	 *
	 * A socket the object closed deliberately still delivers a close event, and
	 * the reconnect it would ask for has already happened. Stamping every
	 * listener with the generation it was registered under is what makes those
	 * events cheap to drop.
	 */
	private generation = 0
	private connectedAt: number | undefined

	/**
	 * Steps run one at a time, in arrival order.
	 *
	 * A step reads the connector's state, transitions it and writes it back, with
	 * `await`s in between — so two frames arriving together would both read the
	 * same state and the second would overwrite the first's. On this protocol that
	 * silently loses a sequence number or a session id. Chaining also keeps events
	 * reaching the handler in the order the socket delivered them, which is the
	 * order a conversation happened in.
	 *
	 * A promise chain rather than a shared `Deferred`: a Deferred resolved from
	 * one request's I/O context and awaited from another is how this codebase has
	 * broken workerd before.
	 */
	private steps: Promise<void> = Promise.resolve()

	constructor(
		private readonly ctx: ConnectorSocketState,
		private readonly env: Record<string, unknown>,
	) {}

	/**
	 * Bring the connection up if it is not up, and make sure a timer is armed.
	 *
	 * Idempotent and cheap: this is called on every cron tick, for every
	 * socket-ingress connector that has its configuration.
	 */
	async ensureConnected(connectorId: string): Promise<void> {
		await this.ctx.storage.put(KEY.connectorId, connectorId)
		await this.tick()
	}

	/** The timer. Serves the heartbeat, the reconnect backoff and the watchdog. */
	async alarm(): Promise<void> {
		await this.tick()
	}

	/** The one place that decides what should be happening right now. */
	private async tick(): Promise<void> {
		const now = Date.now()
		const stoppedUntil = await this.ctx.storage.get<number>(KEY.stoppedUntil)
		if (stoppedUntil !== undefined && stoppedUntil > now) {
			await this.ctx.storage.setAlarm(stoppedUntil)
			return
		}
		if (stoppedUntil !== undefined) await this.ctx.storage.delete(KEY.stoppedUntil)

		if (this.socket === undefined) {
			const reconnectAt = await this.ctx.storage.get<number>(KEY.reconnectAt)
			if (reconnectAt === undefined || reconnectAt <= now) await this.connect()
		} else {
			const heartbeatAt = await this.ctx.storage.get<number>(KEY.heartbeatAt)
			if (heartbeatAt !== undefined && heartbeatAt <= now) {
				// Through the queue like any frame, so a heartbeat cannot interleave
				// with the state a frame arriving at the same moment is rewriting.
				await this.enqueue(this.generation, (ingress, state, at) =>
					ingress.heartbeat(state, at),
				)
			}
		}
		await this.armAlarm(Date.now())
	}

	/**
	 * Dial.
	 *
	 * Under `blockConcurrencyWhile` so a cron tick and an alarm arriving together
	 * cannot open two connections, and so the socket is created while the object
	 * holds its own context rather than in the middle of whichever call got here
	 * first.
	 */
	private async connect(): Promise<void> {
		const resolved = await this.resolve()
		if (resolved === undefined) return
		await this.ctx.blockConcurrencyWhile(async () => {
			if (this.socket !== undefined) return
			const state = await this.protocolState(resolved.ingress)
			const url = socketUrl(resolved.ingress.connectUrl(state, resolved.config))
			if (url === undefined) {
				console.error(
					`[chat-bot.socket] ${resolved.connector.id} asked for a connection to something that is not a WebSocket URL`,
				)
				await this.applyDirective({ _tag: "reconnect", closeCode: NORMAL_CLOSE }, Date.now())
				return
			}
			const generation = ++this.generation
			const socket = new WebSocket(url)
			this.socket = socket
			this.connectedAt = undefined
			socket.addEventListener("open", () => {
				this.connectedAt = Date.now()
				this.dispatch(generation, (ingress, current, now) => ingress.onOpen(current, now))
			})
			socket.addEventListener("message", (event) => {
				const frame = textFrame(event.data)
				if (frame === undefined) return
				this.dispatch(generation, (ingress, current, now, config) =>
					ingress.onFrame(current, frame, now, config),
				)
			})
			socket.addEventListener("close", (event) => {
				this.dispatch(generation, (ingress, current) =>
					ingress.onClose(current, event.code, event.reason),
				)
			})
			// An error event carries no code. `1006` is what an abnormally closed
			// connection reports, which is what this is.
			socket.addEventListener("error", () => {
				this.dispatch(generation, (ingress, current) =>
					ingress.onClose(current, 1006, "socket error"),
				)
			})
		})
	}

	/**
	 * Queue a step on the object's own context, dropping it if the connection has
	 * already moved on — checked again inside `step`, because the generation can
	 * change while this one waits its turn.
	 */
	private dispatch(generation: number, run: RunStep): void {
		if (generation !== this.generation) return
		this.ctx.waitUntil(this.enqueue(generation, run))
	}

	/**
	 * Put a step at the end of the queue and hand back when it has run.
	 *
	 * The `catch` is what keeps the queue alive: a rejected link would leave every
	 * later step unrun, which is a connection that goes quiet rather than one that
	 * reconnects.
	 */
	private enqueue(generation: number, run: RunStep): Promise<void> {
		this.steps = this.steps
			.then(() => this.step(generation, run))
			.catch((cause: unknown) => {
				console.error("[chat-bot.socket] step failed", cause)
			})
		return this.steps
	}

	private async step(generation: number, run: RunStep): Promise<void> {
		const resolved = await this.resolve()
		if (resolved === undefined || generation !== this.generation) return
		const now = Date.now()
		const state = await this.protocolState(resolved.ingress)
		const step = run(resolved.ingress, state, now, resolved.config)
		const program = applyStep(
			{
				connectorId: resolved.connector.id,
				// Guarded on the socket being open: workerd THROWS on a send to a
				// closed one, and a throw here would abort the step before the
				// state write below — losing the session to a race the protocol
				// notices anyway, at its next unacknowledged heartbeat.
				sink: {
					send: (frame) => {
						if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame)
					},
				},
				store: {
					write: (next) => Effect.promise(() => this.ctx.storage.put(KEY.protocol, next)),
				},
			},
			step,
		)
		// This object is the entry point for everything a socket frame causes:
		// nothing above it is running an Effect, so the layer is composed and
		// provided here or nowhere.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		await Effect.runPromise(program.pipe(Effect.provide(StepLayer))).catch((cause: unknown) => {
			console.error("[chat-bot.socket] step failed", cause)
		})
		if (step.heartbeatAt !== undefined) {
			await this.ctx.storage.put(KEY.heartbeatAt, step.heartbeatAt)
		}
		if (step.directive !== undefined) await this.applyDirective(step.directive, now)
		await this.armAlarm(Date.now())
	}

	private async applyDirective(directive: SocketDirective, now: number): Promise<void> {
		const established = this.connectedAt !== undefined && now - this.connectedAt >= ESTABLISHED_MS
		// Bump first: the close below delivers an event this object no longer wants.
		this.generation += 1
		this.socket?.close(directive._tag === "reconnect" ? directive.closeCode : NORMAL_CLOSE)
		this.socket = undefined
		this.connectedAt = undefined
		await this.ctx.storage.delete(KEY.heartbeatAt)

		if (directive._tag === "stop") {
			await this.ctx.storage.put(KEY.stoppedUntil, now + STOP_RETRY_MS)
			const connectorId = await this.ctx.storage.get<string>(KEY.connectorId)
			console.error(
				`[chat-bot.socket] ${connectorId ?? "connector"} stopped: ${directive.reason}`,
			)
			return
		}
		// Consecutive failures. A connection that stayed up past `ESTABLISHED_MS`
		// clears the count, so a long-lived socket dropping once retries promptly
		// rather than at whatever delay it reached months ago.
		const failures = established ? 0 : ((await this.ctx.storage.get<number>(KEY.attempt)) ?? 0) + 1
		await this.ctx.storage.put(KEY.attempt, failures)
		// `failures - 1`, so the FIRST failure waits `RECONNECT_BASE_MS` — the
		// delay is indexed from zero, the count from one.
		await this.ctx.storage.put(KEY.reconnectAt, now + reconnectDelayMs(failures - 1))
	}

	/** The earliest thing the object is waiting for, never sooner than `MIN_ALARM_MS`. */
	private async armAlarm(now: number): Promise<void> {
		const pending = [
			now + WATCHDOG_MS,
			await this.ctx.storage.get<number>(KEY.heartbeatAt),
			this.socket === undefined
				? await this.ctx.storage.get<number>(KEY.reconnectAt)
				: undefined,
		].filter((at): at is number => at !== undefined)
		await this.ctx.storage.setAlarm(Math.max(Math.min(...pending), now + MIN_ALARM_MS))
	}

	private async protocolState(ingress: SocketIngress): Promise<string> {
		return (await this.ctx.storage.get<string>(KEY.protocol)) ?? ingress.initialState
	}

	/**
	 * Which connector this object is, and whether it can run.
	 *
	 * Missing configuration is not reported here: the trigger already skips a
	 * connector it has no credentials for, with one log line, so reaching this
	 * without them means the credentials were removed under a live connection.
	 */
	private async resolve(): Promise<ResolvedConnector | undefined> {
		const connectorId = await this.ctx.storage.get<string>(KEY.connectorId)
		if (connectorId === undefined) return undefined
		const connector = connectors.find((candidate) => candidate.id === connectorId)
		if (connector === undefined || connector.ingress.kind !== "socket") return undefined
		const config = resolveConnectorConfig(this.env, connector)
		if (config._tag === "missing") return undefined
		return { connector, ingress: connector.ingress, config: config.config }
	}
}

export interface ConnectorSocketApi {
	readonly ensureConnected: (connectorId: ChatConnectorId) => Effect.Effect<void>
	readonly alarm: () => Effect.Effect<void>
}

/**
 * One activation, in alchemy's two phases: the outer Effect resolves the state
 * and env — it also runs at plan time against a mock state, so it must not touch
 * storage — and the inner one returns the object's methods as Effects, which
 * alchemy's bridge runs per RPC call.
 */
export const activateConnectorSocket = Effect.map(
	Effect.all([Cloudflare.DurableObjectState, Cloudflare.WorkerEnvironment]),
	([state, env]) =>
		Effect.sync(() => {
			const socket = new ConnectorSocket(state.raw, env)
			return {
				ensureConnected: (connectorId) =>
					Effect.promise(() => socket.ensureConnected(connectorId)),
				alarm: () => Effect.promise(() => socket.alarm()),
			} satisfies ConnectorSocketApi
		}),
)

/** The Durable Object: one per socket-ingress connector id, hosted by this Worker. */
export class ConnectorSocketObject extends Cloudflare.DurableObject<
	ConnectorSocketObject,
	ConnectorSocketApi
>()("ConnectorSocket") {}

// `<never>` pinned for the same reason `ChatSessionObject`'s is: the activation's
// requirements are all `DurableObjectServices`, which `.make` discharges, and
// inference would otherwise widen them into the layer and surface them in the
// root stack.
export const ConnectorSocketLive = ConnectorSocketObject.make<never>(activateConnectorSocket)
