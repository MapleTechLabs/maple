/**
 * The Discord Gateway v10 protocol, as a pure state machine.
 *
 * No I/O, no clock, no randomness: every function takes the state and one input
 * and returns the next state plus what the host should do. That is what makes
 * the awkward half of this protocol — heartbeat acknowledgement tracking,
 * session resumption, invalid sessions, close-code classification — a table of
 * recorded frames in `gateway.test.ts` instead of something only a live bot can
 * exercise.
 *
 * Single shard. Discord requires sharding above 2500 guilds; below it a shard
 * count is an argument that only makes the handshake more fragile.
 *
 * Verified against the Gateway reference (API v10): opcodes, the HELLO →
 * IDENTIFY/RESUME handshake, the jittered first heartbeat, the zombie-connection
 * rule, `resume_gateway_url`, and the close-code table.
 */
import { Option, Schema } from "effect"
import type { ConnectorConfig, SocketDirective, SocketIngressDefinition, SocketStep } from "../../ingress.ts"
import { BOT_TOKEN_CONFIG } from "./api.ts"
import { mapDispatch } from "./gateway-events.ts"
import {
	decodeGatewayFrame,
	decodeHello,
	decodeReady,
	FATAL_CLOSE_CODES,
	GATEWAY_QUERY,
	GATEWAY_URL,
	INTENTS,
	OP,
	RECONNECT_CLOSE_CODE,
	SESSION_RESET_CLOSE_CODES,
} from "./gateway-payloads.ts"

/**
 * The bot token, from the application's Bot tab. See this directory's README.
 *
 * Named in `./api.ts`, which is also where the outbound half's `DiscordBotToken`
 * service says the host reads it from — one secret under one name.
 */
export const BOT_TOKEN = BOT_TOKEN_CONFIG

/**
 * How long a connection may go without a HELLO before it is abandoned.
 *
 * Discord sends HELLO immediately on connect, so silence here means the socket
 * came up against something that is not the gateway. Without this the
 * connection would sit open forever: with no HELLO there is no heartbeat
 * interval, and therefore nothing else that would ever notice.
 */
const HELLO_TIMEOUT_MS = 20_000

/**
 * The connector's own state, persisted by the host between activations.
 *
 * `Schema.optional` rather than `optionalKey`: this is a JavaScript value the
 * state machine rewrites, not a decoded wire payload, and clearing a session is
 * naturally written as `sessionId: undefined`.
 */
export const GatewayState = Schema.Struct({
	/** From READY. Present with `resumeUrl` means the next connect is a RESUME. */
	sessionId: Schema.optional(Schema.String),
	resumeUrl: Schema.optional(Schema.String),
	/** The last `s` seen on any dispatch — what a heartbeat and a RESUME both carry. */
	sequence: Schema.optional(Schema.Number),
	/** From HELLO. Absent means the handshake has not happened on this connection. */
	heartbeatIntervalMs: Schema.optional(Schema.Number),
	/** A heartbeat is outstanding. Still true at the next one means a zombie connection. */
	awaitingAck: Schema.Boolean,
	/** From READY. Without it there is no way to tell a mention from any other message. */
	botUserId: Schema.optional(Schema.String),
})
export type GatewayState = Schema.Schema.Type<typeof GatewayState>

const initialState: GatewayState = { awaitingAck: false }

const reconnect: SocketDirective = { _tag: "reconnect", closeCode: RECONNECT_CLOSE_CODE }

const frame = (op: number, d: unknown): string => JSON.stringify({ op, d })

const heartbeatFrame = (state: GatewayState): string => frame(OP.heartbeat, state.sequence ?? null)

const identifyFrame = (config: ConnectorConfig): string =>
	frame(OP.identify, {
		token: config.get(BOT_TOKEN) ?? "",
		intents: INTENTS,
		properties: { os: "linux", browser: "maple", device: "maple" },
	})

const resumeFrame = (state: GatewayState, config: ConnectorConfig): string =>
	frame(OP.resume, {
		token: config.get(BOT_TOKEN) ?? "",
		session_id: state.sessionId,
		seq: state.sequence ?? null,
	})

/** Forget the session so the next connect identifies fresh. */
const withoutSession = (state: GatewayState): GatewayState => ({
	...state,
	sessionId: undefined,
	resumeUrl: undefined,
	sequence: undefined,
})

const connectUrl = (state: GatewayState): string =>
	state.sessionId !== undefined && state.resumeUrl !== undefined
		? `${state.resumeUrl.replace(/\/+$/u, "")}/${GATEWAY_QUERY}`
		: GATEWAY_URL

/**
 * A fresh connection sends nothing and waits for HELLO — but arms the timer, so
 * a gateway that never says hello is noticed by the same mechanism that notices
 * one that stops answering.
 */
const onOpen = (state: GatewayState, now: number): SocketStep<GatewayState> => ({
	state: { ...state, awaitingAck: false, heartbeatIntervalMs: undefined },
	heartbeatAt: now + HELLO_TIMEOUT_MS,
})

/**
 * HELLO: adopt the interval and finish the handshake.
 *
 * A stored session resumes; otherwise this identifies. Discord asks for the
 * FIRST heartbeat to be delayed by `interval * jitter` so that a fleet of
 * clients reconnecting together does not heartbeat in lockstep. A fixed half
 * interval serves that purpose for a single-socket bot and keeps the state
 * machine deterministic, which is worth more here than an unobservable random
 * offset.
 */
const onHello = (
	state: GatewayState,
	payload: unknown,
	now: number,
	config: ConnectorConfig,
): SocketStep<GatewayState> => {
	const hello = decodeHello(payload)
	if (Option.isNone(hello)) return { state, directive: reconnect }
	const interval = hello.value.heartbeat_interval
	const resuming = state.sessionId !== undefined
	return {
		state: { ...state, heartbeatIntervalMs: interval, awaitingAck: false },
		send: [resuming ? resumeFrame(state, config) : identifyFrame(config)],
		heartbeatAt: now + Math.floor(interval / 2),
	}
}

/** READY: the session identity, and the bot's own user id, which is what makes a mention a mention. */
const onReady = (state: GatewayState, payload: unknown): SocketStep<GatewayState> => {
	const ready = decodeReady(payload)
	if (Option.isNone(ready)) return { state }
	return {
		state: {
			...state,
			sessionId: ready.value.session_id,
			resumeUrl: ready.value.resume_gateway_url,
			botUserId: ready.value.user.id,
		},
	}
}

// BOUNDARY: `frameText` is whatever the socket delivered; decoded at this edge.
const onFrame = (
	state: GatewayState,
	frameText: string,
	now: number,
	config: ConnectorConfig,
): SocketStep<GatewayState> => {
	const decoded = decodeGatewayFrame(frameText)
	// A frame that does not parse is dropped with the state untouched. Closing a
	// healthy connection over one unreadable frame costs a whole handshake and
	// fixes nothing.
	if (Option.isNone(decoded)) return { state }
	const { op, d, s, t } = decoded.value
	// Every dispatch advances the sequence, including the ones nothing is done
	// with: it is what a heartbeat and a RESUME both replay.
	const current: GatewayState = s === undefined || s === null ? state : { ...state, sequence: s }

	switch (op) {
		case OP.hello:
			return onHello(current, d, now, config)
		case OP.heartbeatAck:
			return { state: { ...current, awaitingAck: false } }
		// A server-initiated heartbeat is answered at once rather than at the next
		// interval, and starts an acknowledgement window like any other.
		case OP.heartbeat:
			return {
				state: { ...current, awaitingAck: true },
				send: [heartbeatFrame(current)],
				heartbeatAt: now + (current.heartbeatIntervalMs ?? HELLO_TIMEOUT_MS),
			}
		// Reconnect and RESUME. The session is kept, so `connectUrl` returns the
		// resume host.
		case OP.reconnect:
			return { state: current, directive: reconnect }
		// `d` is whether the session may still be resumed. `false` — the common
		// case — means identify fresh, which is what forgetting the session does.
		case OP.invalidSession:
			return { state: d === true ? current : withoutSession(current), directive: reconnect }
		case OP.dispatch: {
			if (t === undefined || t === null) return { state: current }
			if (t === "READY") return onReady(current, d)
			const { events, requests } = mapDispatch(t, d, current.botUserId)
			return { state: current, events, requests }
		}
		default:
			return { state: current }
	}
}

/**
 * The close-code table, applied.
 *
 * Anything Discord documents as non-reconnectable stops the loop and is
 * reported; a session-invalidating code reconnects without the session;
 * everything else — including the plain WebSocket-level codes a dropped
 * connection produces — reconnects and resumes, which is the whole point of
 * holding the session.
 */
const onClose = (state: GatewayState, code: number, reason: string): SocketStep<GatewayState> => {
	if (FATAL_CLOSE_CODES.has(code)) {
		return {
			state,
			directive: {
				_tag: "stop",
				reason: `Discord closed the gateway with ${code}${reason === "" ? "" : `: ${reason}`}`,
			},
		}
	}
	return {
		state: SESSION_RESET_CLOSE_CODES.has(code) ? withoutSession(state) : state,
		directive: reconnect,
	}
}

/**
 * The timer fired.
 *
 * Three cases, and the first two are failures the connection cannot report
 * itself: no HELLO arrived, or the last heartbeat was never acknowledged.
 * Discord's rule for the latter is to terminate with a code other than 1000 or
 * 1001 and resume, which is exactly what a reconnect directive does here.
 */
const heartbeat = (state: GatewayState, now: number): SocketStep<GatewayState> => {
	const interval = state.heartbeatIntervalMs
	if (interval === undefined) return { state, directive: reconnect }
	if (state.awaitingAck) return { state, directive: reconnect }
	return {
		state: { ...state, awaitingAck: true },
		send: [heartbeatFrame(state)],
		heartbeatAt: now + interval,
	}
}

export const gatewayProtocol: SocketIngressDefinition<GatewayState> = {
	requiredConfig: [{ name: BOT_TOKEN, secret: true }],
	stateSchema: Schema.fromJsonString(GatewayState),
	initialState,
	connectUrl,
	onOpen,
	onFrame,
	onClose,
	heartbeat,
}
