/**
 * Hazel's bot gateway protocol, as a pure state machine.
 *
 * No I/O, no clock: every function takes the state and one input and returns the next state plus
 * what the host should do, so the protocol is a table of recorded frames in `gateway.test.ts`.
 *
 * The protocol (`@hazel/domain`'s `bot-gateway.ts`): the server says HELLO with a heartbeat
 * interval; the client IDENTIFYs with its token, or RESUMEs a session it holds, from an offset;
 * READY names the session (and the bot's user); events arrive in DISPATCH batches, one batch in
 * flight at a time, each acknowledged by echoing its `nextOffset` — an unacknowledged batch is
 * redelivered on the next connection, and the gateway asks for a reconnect after a minute without
 * one. HEARTBEATs keep the connection; RECONNECT and INVALID_SESSION end it.
 *
 * One session per bot token: a second IDENTIFY is refused while a session is live, and only a
 * RESUME of the live session's own id replaces it. So the session id is kept across every reconnect
 * and deploy, and a fresh IDENTIFY happens only when there is none.
 */
import { Option, Schema } from "effect"
import type { ConnectorConfig, SocketDirective, SocketIngressDefinition, SocketStep } from "../../ingress.ts"
import { BOT_TOKEN_CONFIG, GATEWAY_URL } from "./api.ts"
import { mapEvents } from "./gateway-events.ts"
import {
	decodeServerFrame,
	INVALID_TOKEN_REASON,
	RECONNECT_CLOSE_CODE,
	SESSION_CONFLICT_REASON,
} from "./gateway-payloads.ts"

/** How long a connection may go without a HELLO before it is abandoned. Hazel sends it at once. */
const HELLO_TIMEOUT_MS = 20_000

/**
 * Where a session with no offset of its own starts: new events only. `-1` would replay the week of
 * events the gateway retains, and every one of them would be answered.
 */
const FIRST_OFFSET = "now"

export const GatewayState = Schema.Struct({
	/** From READY. Kept across reconnects: it is what lets this connection replace a stale one. */
	sessionId: Schema.optional(Schema.String),
	/** The last batch's `nextOffset`, acknowledged — where a reconnect resumes. */
	offset: Schema.optional(Schema.String),
	/** From HELLO. Absent means the handshake has not happened on this connection. */
	heartbeatIntervalMs: Schema.optional(Schema.Number),
	/** A heartbeat is outstanding. Still true at the next one means a dead connection. */
	awaitingAck: Schema.Boolean,
	/** From READY. Without it a mention cannot be told from any other message. */
	botUserId: Schema.optional(Schema.String),
})
export type GatewayState = Schema.Schema.Type<typeof GatewayState>

const initialState: GatewayState = { awaitingAck: false }

const reconnect: SocketDirective = { _tag: "reconnect", closeCode: RECONNECT_CLOSE_CODE }

const token = (config: ConnectorConfig): string => config.get(BOT_TOKEN_CONFIG) ?? ""

const handshakeFrame = (state: GatewayState, config: ConnectorConfig): string => {
	const resumeOffset = state.offset ?? FIRST_OFFSET
	return JSON.stringify(
		state.sessionId === undefined
			? { op: "IDENTIFY", botToken: token(config), resumeOffset }
			: { op: "RESUME", botToken: token(config), sessionId: state.sessionId, resumeOffset },
	)
}

const heartbeatFrame = (state: GatewayState): string =>
	JSON.stringify(
		state.sessionId === undefined ? { op: "HEARTBEAT" } : { op: "HEARTBEAT", sessionId: state.sessionId },
	)

const onOpen = (state: GatewayState, now: number): SocketStep<GatewayState> => ({
	state: { ...state, awaitingAck: false, heartbeatIntervalMs: undefined },
	heartbeatAt: now + HELLO_TIMEOUT_MS,
})

// BOUNDARY: `frameText` is whatever the socket delivered; decoded at this edge.
const onFrame = (
	state: GatewayState,
	frameText: string,
	now: number,
	config: ConnectorConfig,
): SocketStep<GatewayState> => {
	const decoded = decodeServerFrame(frameText)
	// An unreadable frame is dropped with the state untouched: closing a healthy connection over
	// one costs a handshake and fixes nothing.
	if (Option.isNone(decoded)) return { state }
	const frame = decoded.value
	switch (frame.op) {
		case "HELLO":
			return {
				state: { ...state, heartbeatIntervalMs: frame.heartbeatIntervalMs, awaitingAck: false },
				send: [handshakeFrame(state, config)],
				heartbeatAt: now + frame.heartbeatIntervalMs,
			}
		case "READY":
			return {
				state: {
					...state,
					sessionId: frame.sessionId,
					botUserId: frame.botUserId ?? state.botUserId,
				},
			}
		case "DISPATCH":
			// Acknowledged as it arrives: the events are handed to the host in this same step, and
			// holding the ACK back would only have the gateway redeliver what was already handled.
			return {
				state: { ...state, sessionId: frame.sessionId, offset: frame.nextOffset },
				send: [
					JSON.stringify({ op: "ACK", sessionId: frame.sessionId, nextOffset: frame.nextOffset }),
				],
				events: mapEvents(frame.events, state.botUserId),
			}
		case "HEARTBEAT_ACK":
			return { state: { ...state, awaitingAck: false } }
		case "RECONNECT":
			return { state, directive: reconnect }
		case "INVALID_SESSION":
			if (frame.reason === INVALID_TOKEN_REASON) {
				return {
					state,
					directive: {
						_tag: "stop",
						reason: "Hazel refused the bot token: set MAPLE_HAZEL_BOT_TOKEN to the bot's current token",
					},
				}
			}
			// Another live session for this token (a connection the host has not seen close yet) is
			// freed by the gateway's own watchdog: back off and try again with the session kept, so
			// a RESUME of it replaces the stale socket. Anything else forgets the session.
			return {
				state: frame.reason === SESSION_CONFLICT_REASON ? state : { ...state, sessionId: undefined },
				directive: reconnect,
			}
	}
}

/** Every close reconnects and resumes: Hazel has no close code that a reconnect cannot fix. */
const onClose = (state: GatewayState): SocketStep<GatewayState> => ({ state, directive: reconnect })

/** The timer: no HELLO arrived, the last heartbeat went unanswered, or one is due. */
const heartbeat = (state: GatewayState, now: number): SocketStep<GatewayState> => {
	const interval = state.heartbeatIntervalMs
	if (interval === undefined || state.awaitingAck) return { state, directive: reconnect }
	return {
		state: { ...state, awaitingAck: true },
		send: [heartbeatFrame(state)],
		heartbeatAt: now + interval,
	}
}

export const gatewayProtocol: SocketIngressDefinition<GatewayState> = {
	requiredConfig: [{ name: BOT_TOKEN_CONFIG, secret: true }],
	stateSchema: Schema.fromJsonString(GatewayState),
	initialState,
	connectUrl: () => GATEWAY_URL,
	onOpen,
	onFrame,
	onClose,
	heartbeat,
}
