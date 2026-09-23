/**
 * How a chat platform's events reach Maple, and what they look like once they
 * have.
 *
 * This file is the contract the host — `apps/chat-bot` — programs against. It
 * names no vendor, and it is deliberately the narrowest surface that lets the
 * host run a connector without understanding the platform's protocol: the host
 * owns every socket, timer and HTTP call, and the connector owns every byte
 * that goes over them.
 *
 * Two kinds, because chat platforms arrive two ways:
 *
 *   - `webhook` — the platform POSTs a signed request. The connector verifies
 *     the signature itself (the host has no idea what signing even means here)
 *     and returns the response to send back plus the events it recognised.
 *   - `socket` — the platform only delivers over a persistent connection the
 *     client opens. The connector supplies a **pure protocol state machine**;
 *     the host opens the socket, feeds frames in, sends what comes back, and
 *     persists the state so a restart resumes rather than re-handshakes.
 *
 * The socket half is deliberately I/O-free. That is what makes a protocol as
 * fiddly as a gateway handshake — heartbeats, acknowledgement tracking, session
 * resumption, close-code classification — testable as a table of recorded
 * frames, and it is what keeps the host's Durable Object a thin shell around a
 * socket rather than a second implementation of the protocol.
 */
import type { Effect } from "effect"
import { Option, Schema } from "effect"
import type { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ChatConnectorId } from "./connector.ts"

// Configuration

/**
 * One environment value a connector needs in order to run at all.
 *
 * The connector declares the NAMES (they may well be vendor-flavoured — they
 * live inside the connector directory); the host resolves them from its own env
 * and hands the values back. A connector never reads `process.env`, so a
 * connector is testable without one and the host stays the single place that
 * knows how this deployment is configured.
 *
 * `secret` is the only attribute: it is what decides whether the deploy binds
 * the value as a Worker secret or as a plain variable.
 */
export interface ConnectorConfigKey {
	readonly name: string
	readonly secret: boolean
}

/**
 * The resolved values, by name. A `Map` rather than a record so a missing key is
 * `undefined` without an index signature the reader has to defend against.
 */
export type ConnectorConfig = ReadonlyMap<string, string>

// Normalized inbound events

/**
 * Who took an action, with the raw material for deciding whether they were
 * allowed to.
 *
 * Authorization stays DATA here on purpose. Which role may approve an agent's
 * proposed mutation is a Maple decision held against the workspace's configured
 * approver role, so this carries the membership facts and none of the verdict —
 * every platform can answer "which groups is this person in" and "are they an
 * administrator of this workspace", and none of them knows what Maple does with
 * the answer.
 */
export const InboundActor = Schema.Struct({
	id: Schema.String,
	displayName: Schema.String,
	roleIds: Schema.Array(Schema.String),
	isWorkspaceAdmin: Schema.Boolean,
})
export type InboundActor = Schema.Schema.Type<typeof InboundActor>

/**
 * A message a human wrote where the bot can see it.
 *
 * Not necessarily one addressed to it: a connector also reports the messages it can read that
 * mention nobody, because in a conversation the bot opened the next message is still part of the
 * exchange. `mentionsBot` is the whole difference, and what the host does with a `false` is a host
 * decision — see `apps/chat-bot/src/relay/conversation.ts`.
 */
export const InboundMessage = Schema.Struct({
	type: Schema.Literal("message"),
	connector: ChatConnectorId,
	/** The platform's tenant — the server, workspace or team the bot was installed into. */
	workspaceId: Schema.String,
	/** Where a reply goes. */
	channelId: Schema.String,
	/**
	 * The sub-conversation a reply must target, where the platform models one
	 * separately from the channel. Absent where a thread IS a channel and
	 * `channelId` already addresses it.
	 */
	threadId: Schema.optionalKey(Schema.String),
	messageId: Schema.String,
	author: Schema.Struct({
		id: Schema.String,
		displayName: Schema.String,
		isBot: Schema.Boolean,
	}),
	/** The bot's own mention removed, so a turn does not start with its own name. */
	text: Schema.String,
	mentionsBot: Schema.Boolean,
})
export type InboundMessage = Schema.Schema.Type<typeof InboundMessage>

/** Someone pressed a button Maple rendered — today, an approval on a proposed mutation. */
export const InboundAction = Schema.Struct({
	type: Schema.Literal("action"),
	connector: ChatConnectorId,
	workspaceId: Schema.String,
	channelId: Schema.String,
	/** The message carrying the control, so the reply can update it in place. */
	messageId: Schema.String,
	/**
	 * Whatever Maple put on the control when it rendered it, handed back verbatim.
	 * The connector round-trips it; it never parses it.
	 *
	 * Deliberately a plain string and NOT `ChatActionToken`, which is what
	 * `./action-token.ts` mints on the way out. What arrives here came off the
	 * wire and may be anything a forged interaction carried, so branding it at
	 * this boundary would launder unvalidated input into a type that claims it
	 * was validated. The handler decodes it with `decodeChatActionToken`, which
	 * answers `undefined` for everything that is not one.
	 */
	actionToken: Schema.String,
	actor: InboundActor,
})
export type InboundAction = Schema.Schema.Type<typeof InboundAction>

/** The bot was removed from a workspace — the link is gone, nothing to reply to. */
export const InboundWorkspaceRemoved = Schema.Struct({
	type: Schema.Literal("workspace-removed"),
	connector: ChatConnectorId,
	workspaceId: Schema.String,
})
export type InboundWorkspaceRemoved = Schema.Schema.Type<typeof InboundWorkspaceRemoved>

/**
 * Everything a connector can report.
 *
 * Three cases, because three things happen downstream: start a turn, apply an
 * approval, unlink a workspace. A platform event that maps to none of them is
 * dropped inside the connector rather than widened into here.
 */
export const InboundEvent = Schema.Union([InboundMessage, InboundAction, InboundWorkspaceRemoved])
export type InboundEvent = Schema.Schema.Type<typeof InboundEvent>

// Ingress failures

/**
 * A connector could not make sense of what the platform sent it — an unverifiable
 * signature, a body that is not the payload it claims to be.
 *
 * Socket ingress does not fail: a frame the state machine cannot use is dropped
 * with the state unchanged, because closing a healthy connection over one bad
 * frame is worse than ignoring it.
 */
export class ConnectorIngressError extends Schema.TaggedError<ConnectorIngressError>()(
	"@maple/chat-platform/ConnectorIngressError",
	{
		connector: ChatConnectorId,
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

// Webhook ingress

export interface WebhookIngressResult {
	/** What to answer the platform with, signature rejections included. */
	readonly response: HttpServerResponse.HttpServerResponse
	readonly events: ReadonlyArray<InboundEvent>
}

export interface WebhookIngress {
	readonly kind: "webhook"
	readonly requiredConfig: ReadonlyArray<ConnectorConfigKey>
	handle(
		request: HttpServerRequest.HttpServerRequest,
		config: ConnectorConfig,
	): Effect.Effect<WebhookIngressResult, ConnectorIngressError>
}

// Socket ingress

/**
 * An HTTP call the connector needs the host to make, now.
 *
 * It exists because some platforms put a deadline on acknowledging an event that
 * arrived over the socket, and the acknowledgement is an HTTP request rather
 * than a frame — so it can ride neither the socket nor the outbound message
 * driver, which renders and posts Maple's *answers* and runs much later.
 * Declaring it as data keeps the connector pure and leaves the host owning the
 * I/O.
 */
export interface ConnectorRequest {
	readonly method: "POST" | "PUT" | "PATCH" | "DELETE"
	readonly url: string
	readonly headers: ReadonlyMap<string, string>
	readonly body: string
}

/**
 * What the host should do with the connection after this step.
 *
 * Only two, and the missing third is deliberate: there is no separate "resume"
 * because the connector already decides that. Its own state records whether it
 * holds a resumable session, and `connectUrl` answers accordingly — so the host
 * reconnecting is one behaviour, not two.
 *
 * `closeCode` travels with the reconnect because at least one platform
 * distinguishes a clean close (which ends the session) from an abnormal one
 * (which leaves it resumable), and that distinction is the connector's to make.
 */
export type SocketDirective =
	| { readonly _tag: "reconnect"; readonly closeCode: number }
	| { readonly _tag: "stop"; readonly reason: string }

/**
 * The result of one step of the protocol.
 *
 * Every member is something the host can do without knowing the platform:
 * remember a value, write frames, hand events on, issue requests, reconnect,
 * set a timer.
 */
export interface SocketStep<State> {
	readonly state: State
	/** Frames to write, in order. */
	readonly send?: ReadonlyArray<string>
	readonly events?: ReadonlyArray<InboundEvent>
	readonly requests?: ReadonlyArray<ConnectorRequest>
	readonly directive?: SocketDirective
	/**
	 * When the host should next call `heartbeat`, as an epoch-ms instant. Absent
	 * leaves the existing schedule standing, so a step that is not about timing
	 * says nothing about it.
	 */
	readonly heartbeatAt?: number
}

/**
 * The connector's half of a socket connection, over its own state type.
 *
 * Every function is pure: same state and same input, same result. `heartbeat` is
 * only called when the instant it last asked for has arrived, so it may assume
 * it is due rather than re-deriving that from the clock.
 */
export interface SocketProtocol<State> {
	/**
	 * How the state survives a host restart. The host stores the encoded string
	 * and hands it back; a value that no longer decodes — after a deploy that
	 * changed the state — falls back to `initialState` rather than wedging the
	 * connector on a value it cannot read.
	 */
	readonly stateSchema: Schema.Codec<State, string>
	readonly initialState: State
	connectUrl(state: State, config: ConnectorConfig): string
	onOpen(state: State, now: number): SocketStep<State>
	onFrame(state: State, frame: string, now: number, config: ConnectorConfig): SocketStep<State>
	onClose(state: State, code: number, reason: string): SocketStep<State>
	heartbeat(state: State, now: number): SocketStep<State>
}

export interface SocketIngressDefinition<State> extends SocketProtocol<State> {
	readonly requiredConfig: ReadonlyArray<ConnectorConfigKey>
}

/**
 * The same protocol with its state erased to the encoded string.
 *
 * The host never holds a decoded connector state, so it needs no generic
 * parameter, no existential and no cast to drive any connector — it shuttles an
 * opaque string between calls and persists it. The encode/decode that buys this
 * runs a handful of times a minute, which is what a heartbeat costs anyway.
 */
export interface SocketIngress {
	readonly kind: "socket"
	readonly requiredConfig: ReadonlyArray<ConnectorConfigKey>
	readonly initialState: string
	connectUrl(state: string, config: ConnectorConfig): string
	onOpen(state: string, now: number): SocketStep<string>
	onFrame(state: string, frame: string, now: number, config: ConnectorConfig): SocketStep<string>
	onClose(state: string, code: number, reason: string): SocketStep<string>
	heartbeat(state: string, now: number): SocketStep<string>
}

export type ConnectorIngress = WebhookIngress | SocketIngress

/** Wrap a typed protocol as the string-state ingress the host consumes. */
export const socketIngress = <State>(definition: SocketIngressDefinition<State>): SocketIngress => {
	const decode = Schema.decodeOption(definition.stateSchema)
	// Asymmetric with `decode` on purpose. A state that will not DECODE is an
	// older deploy's value and a state the host must survive; a state that will
	// not ENCODE is one the connector just built out of its own schema, which is
	// a bug, so it surfaces as a defect rather than being swallowed into a
	// silently reset session.
	const encode = Schema.encodeSync(definition.stateSchema)
	const read = (state: string): State => Option.getOrElse(decode(state), () => definition.initialState)
	const lift = (step: SocketStep<State>): SocketStep<string> => ({
		...step,
		state: encode(step.state),
	})
	return {
		kind: "socket",
		requiredConfig: definition.requiredConfig,
		initialState: encode(definition.initialState),
		connectUrl: (state, config) => definition.connectUrl(read(state), config),
		onOpen: (state, now) => lift(definition.onOpen(read(state), now)),
		onFrame: (state, frame, now, config) => lift(definition.onFrame(read(state), frame, now, config)),
		onClose: (state, code, reason) => lift(definition.onClose(read(state), code, reason)),
		heartbeat: (state, now) => lift(definition.heartbeat(read(state), now)),
	}
}
