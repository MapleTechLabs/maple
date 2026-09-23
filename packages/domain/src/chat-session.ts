/**
 * Wire contract for Maple's own durable chat transport, which replaces Flue's.
 *
 * Three shapes live here so the Worker, the web client and the mobile client cannot drift:
 *
 *   - `ChatSessionId` — `"<orgId>:<tabId>"`. The org is recovered *server-side* from the id and
 *     matched against the caller's token; it is never read from a request body.
 *   - `ChatEvent` — the durable, replayable event log. Every event carries a monotonic `seq`, so a
 *     reconnect is `GET .../events?cursor=<last seq>` and the transport is resumable by
 *     construction rather than by reconnect heuristics.
 *   - `ChatMessage` — the materialized transcript a cold client reads before it starts streaming.
 *
 * The event names are deliberately Maple's, not `@opencode-ai/ai`'s: `LLMEvent` is a provider-neutral
 * *model* stream, while this is a *session* stream that also carries user turns, approval gates and
 * turn lifecycle. `apps/api/src/chat/events.ts` is the only place the two are mapped.
 */
import { Option, Schema } from "effect"
import {
	ActorId,
	AuthMode,
	ChatConnectorId,
	ChatConversationKey,
	ExternalUserId,
	OrgId,
	RoleName,
	UserId,
} from "./primitives"

// Session addressing

/**
 * `"<orgId>:<tabId>"`. Mirrors the addressing Flue used (and the chat-agent Durable Object naming
 * before it), so existing deep links into a conversation keep working.
 */
export const ChatSessionId = Schema.String.pipe(Schema.brand("@maple/ChatSessionId"))
export type ChatSessionId = typeof ChatSessionId.Type

const decodeChatSessionId = Schema.decodeUnknownSync(ChatSessionId)

export const makeChatSessionId = (orgId: string, tabId: string): ChatSessionId =>
	decodeChatSessionId(`${orgId}:${tabId}`)

/**
 * Recover the org from a session id. Deny-by-default: a colon-less or leading-colon id carries no
 * resolvable org, so callers must reject it rather than treat the whole string as the org.
 */
export const orgIdFromChatSessionId = (sessionId: string): string | undefined => {
	const index = sessionId.indexOf(":")
	return index <= 0 ? undefined : sessionId.slice(0, index)
}

/** Everything after the first `:`. The tab-id prefix encodes the conversation mode. */
export const tabIdFromChatSessionId = (sessionId: string): string => {
	const index = sessionId.indexOf(":")
	return index === -1 ? "" : sessionId.slice(index + 1)
}

/** Recover the investigation id from an `inv-<id>` tab. `undefined` for other modes. */
export const investigationIdFromChatSessionId = (sessionId: string): string | undefined => {
	const tab = tabIdFromChatSessionId(sessionId)
	return tab.startsWith("inv-") ? tab.slice("inv-".length) : undefined
}

/** The chat session a pull request review runs on: `<orgId>:pr-<reviewId>`. */
export const prReviewSessionId = (orgId: string, reviewId: string): string => `${orgId}:pr-${reviewId}`

/** Recover the pull-request review id from a `pr-<id>` tab. `undefined` for other modes. */
export const prReviewIdFromChatSessionId = (sessionId: string): string | undefined => {
	const tab = tabIdFromChatSessionId(sessionId)
	return tab.startsWith("pr-") ? tab.slice("pr-".length) : undefined
}

/**
 * What a conversation *is* — its persona and its budget.
 *
 * Deliberately not who drives a turn: that is {@link ChatTurnOrigin}, and fusing the two would
 * mean a new mode, a new agent record and a new prompt every time a conversation became reachable
 * from somewhere new. A connector-driven thread is an ordinary chat-mode conversation that a
 * connector is answering in, and it stays free to be anchored on an alert later.
 */
export const ChatMode = Schema.Literals(["default", "alert", "widget-fix", "investigate", "pr-review"])
export type ChatMode = Schema.Schema.Type<typeof ChatMode>

/** Mode is derived from the tab-id prefix, never sent by the client. */
export const chatModeFromSessionId = (sessionId: string): ChatMode => {
	const tab = tabIdFromChatSessionId(sessionId)
	if (tab.startsWith("alert-")) return "alert"
	if (tab.startsWith("widget-fix-")) return "widget-fix"
	if (tab.startsWith("inv-")) return "investigate"
	if (tab.startsWith("pr-")) return "pr-review"
	return "default"
}

const CONNECTOR_TAB_PREFIX = "bot-"

/** Whether this session's transcript belongs to a connector thread rather than the Maple app. */
export const isConnectorSessionId = (sessionId: string): boolean =>
	tabIdFromChatSessionId(sessionId).startsWith(CONNECTOR_TAB_PREFIX)

// Owned by `./primitives` so the engine and the connector packages cannot drift apart.
export { ChatConnectorId, ChatConversationKey } from "./primitives"

/**
 * The session a connector conversation lives in.
 *
 * The connector supplies `conversationKey`, because only it knows what makes a conversation
 * unique on its platform — a thread, a channel, a channel and thread together. Its charset
 * excludes `-`, and a connector id cannot contain one either, so the tab splits unambiguously.
 */
export const connectorSessionId = (
	orgId: OrgId,
	connectorId: ChatConnectorId,
	conversationKey: ChatConversationKey,
): ChatSessionId => makeChatSessionId(orgId, `${CONNECTOR_TAB_PREFIX}${connectorId}-${conversationKey}`)

// Durable transcript

export const ChatRole = Schema.Literals(["user", "assistant"])
export type ChatRole = Schema.Schema.Type<typeof ChatRole>

/**
 * A tool call made *by* a sub-agent.
 *
 * Structurally a `ChatToolCall` minus `task`: sub-agents cannot spawn sub-agents, so there is
 * nothing to nest. Duplicated rather than made recursive with `Schema.suspend` on purpose — the
 * recursion would be unbounded in the type while bounded at runtime, it would force the web
 * client's `UIMessage` recursive too, and a mutual `Schema.Class` recursion is exactly the shape
 * that fails opaquely at module load inside Cloudflare's ~1s startup-CPU budget (error 10021).
 */
export class ChatSubToolCall extends Schema.Class<ChatSubToolCall>("@maple/ChatSubToolCall")({
	id: Schema.String,
	name: Schema.String,
	input: Schema.Unknown,
	output: Schema.optionalKey(Schema.Unknown),
	isError: Schema.optionalKey(Schema.Boolean),
	textOffset: Schema.optionalKey(Schema.Number),
}) {}

export class ChatSubMessage extends Schema.Class<ChatSubMessage>("@maple/ChatSubMessage")({
	id: Schema.String,
	role: ChatRole,
	text: Schema.String,
	toolCalls: Schema.Array(ChatSubToolCall),
	createdAt: Schema.Number,
}) {}

/** A sub-agent run, hanging off the `task` tool call that started it. */
export class ChatTaskState extends Schema.Class<ChatTaskState>("@maple/ChatTaskState")({
	id: Schema.String,
	agent: Schema.String,
	status: Schema.Literals(["running", "completed", "error", "aborted"]),
	messages: Schema.Array(ChatSubMessage),
}) {}

export class ChatToolCall extends Schema.Class<ChatToolCall>("@maple/ChatToolCall")({
	id: Schema.String,
	name: Schema.String,
	/** The phrase its `tool-call` event carried, when it carried one. */
	label: Schema.optionalKey(Schema.String),
	input: Schema.Unknown,
	/** Present once the tool settled. */
	output: Schema.optionalKey(Schema.Unknown),
	isError: Schema.optionalKey(Schema.Boolean),
	/**
	 * True when this call is an approval-gated mutation the agent paused on. The tool did NOT run;
	 * the client renders an approval card and applies it through `POST /internal/chat/apply`.
	 */
	proposed: Schema.optionalKey(Schema.Boolean),
	/** Present on a `task` call: the sub-agent run it started, and that run's own transcript. */
	task: Schema.optionalKey(ChatTaskState),
	/**
	 * How much of the message's `text` had been streamed when the model asked for this call —
	 * the one thing that survives flattening prose and calls into two fields.
	 *
	 * Without it a reloaded turn has no way back to the order the reader watched: every call
	 * lands under all of the prose, so an eight-step investigation reads as one essay followed
	 * by one undifferentiated pile of tools. Optional because conversations recorded before it
	 * existed have nothing to say; those still render prose-then-calls.
	 */
	textOffset: Schema.optionalKey(Schema.Number),
}) {}

export class ChatMessage extends Schema.Class<ChatMessage>("@maple/ChatMessage")({
	id: Schema.String,
	role: ChatRole,
	text: Schema.String,
	toolCalls: Schema.Array(ChatToolCall),
	createdAt: Schema.Number,
	/**
	 * The seq of the event that opened this message.
	 *
	 * A non-unique wall clock in milliseconds cannot order or split a transcript; event sequence
	 * can. Both producers are server-side and have the seq in hand at exactly the right moment, so
	 * this is required rather than optional.
	 */
	startSeq: Schema.Number,
}) {}

export class ChatHistoryResponse extends Schema.Class<ChatHistoryResponse>("@maple/ChatHistoryResponse")({
	messages: Schema.Array(ChatMessage),
	/** Cursor to resume the event stream from; `0` means "from the beginning". */
	cursor: Schema.Number,
	/** True when a turn is in flight, so a reconnecting client shows the streaming state. */
	running: Schema.Boolean,
}) {}

// Event stream

/**
 * Marks an event as belonging to a sub-agent turn nested inside a parent turn.
 *
 * A sub-agent runs *in process*, inside the parent's turn, rather than in a Durable Object of its
 * own — see the design note in `apps/api/src/chat/loop/delegate.ts`. So its events land in the parent's
 * log and need a way to say "I am not part of the top-level conversation". `id` is the parent's
 * `task` tool call id, which is what binds a child transcript to the call that started it.
 *
 * A discriminating field on the existing events rather than a new set of event types: the Durable
 * Object fold, the SSE framing and the client reducer each keep one code path, and the child
 * transcript is literally the same fold applied to a nested array.
 */
export const ChatTaskRef = Schema.Struct({
	/** The parent's `task` tool call id. */
	id: Schema.String,
	/** Which sub-agent produced this, for the UI label. */
	agent: Schema.String,
	/** The assistant message that owns the `task` tool call. */
	parentMessageId: Schema.String,
})
export type ChatTaskRef = Schema.Schema.Type<typeof ChatTaskRef>

/**
 * The prefix every delegation tool carries: one tool per sub-agent, named `task_<agent>`.
 *
 * Here rather than in `apps/api/src/chat/agents.ts`, where it started, because the *client* has to
 * recognise a delegation from the tool name alone. A streamed `tool-call` carries the tool's name
 * and nothing else that says "this opens a sub-agent" — the `task` ref only ever rides on the
 * child's own events — so the web client matched the name against a literal `"task"` and never
 * recognised a single delegation live: every sub-agent rendered as an ordinary tool row until the
 * conversation was reloaded and the server's `ChatToolCall.task` took over. Two spellings of one
 * convention in two apps is exactly the drift this file exists to prevent.
 */
export const DELEGATION_TOOL_PREFIX = "task_"

/** The tool that delegates to `agent`. */
export const delegationToolName = (agent: string): string => `${DELEGATION_TOOL_PREFIX}${agent}`

/** The sub-agent a tool name delegates to, or `undefined` for an ordinary tool. */
export const delegatedAgentOf = (toolName: string): string | undefined =>
	toolName.startsWith(DELEGATION_TOOL_PREFIX) && toolName.length > DELEGATION_TOOL_PREFIX.length
		? toolName.slice(DELEGATION_TOOL_PREFIX.length)
		: undefined

const task = { task: Schema.optionalKey(ChatTaskRef) }

/**
 * Event fields, declared once and used twice: with a `seq` for the wire/`ChatEvent` form, and
 * without for the durable log, whose SQLite row key *is* the seq. Keeping one declaration is what
 * stops the two representations drifting.
 */
const eventFields = {
	"user-message": { type: Schema.Literal("user-message"), id: Schema.String, text: Schema.String },
	"turn-start": { type: Schema.Literal("turn-start"), messageId: Schema.String, ...task },
	"text-delta": {
		type: Schema.Literal("text-delta"),
		messageId: Schema.String,
		text: Schema.String,
		...task,
	},
	"tool-call": {
		type: Schema.Literal("tool-call"),
		messageId: Schema.String,
		callId: Schema.String,
		name: Schema.String,
		input: Schema.Unknown,
		/** Approval-gated mutation: the tool did not run, this is a proposal. */
		proposed: Schema.optionalKey(Schema.Boolean),
		/** What the call is doing, for a reader (`Running a query`); absent for a tool with no phrase. */
		label: Schema.optionalKey(Schema.String),
		...task,
	},
	"tool-result": {
		type: Schema.Literal("tool-result"),
		messageId: Schema.String,
		callId: Schema.String,
		output: Schema.Unknown,
		isError: Schema.optionalKey(Schema.Boolean),
		...task,
	},
	/**
	 * A step failed transiently and is about to be retried. Two jobs in one event, because either
	 * alone is useless: it retracts text that never happened, and it tells the client why the answer
	 * paused.
	 *
	 * `retractChars` is what makes retry safe after tokens have already shipped. It rests on an
	 * invariant of the turn loop: within one step, `tool-call` and `tool-result` are only emitted
	 * *after* the model stream completed successfully, so a failed attempt emitted nothing but
	 * `text-delta`s and truncating by a character count is a complete undo.
	 *
	 * Old clients skip unrecognised frames (see `decodeChatEvent`), so a client deployed before this
	 * event existed shows the retracted prefix twice rather than dropping the stream. Degraded, not
	 * broken — and web ships with the API.
	 */
	"turn-retry": {
		type: Schema.Literal("turn-retry"),
		messageId: Schema.String,
		/** 1-based number of the attempt about to be made. */
		attempt: Schema.Number,
		/** Characters of this message's text that never happened; readers truncate by this much. */
		retractChars: Schema.Number,
		/** `LlmCallError.reason`, for display and for triage. */
		reason: Schema.String,
		/** Milliseconds until the attempt starts, so a client can show a countdown. */
		delayMs: Schema.Number,
		...task,
	},
	"turn-end": {
		type: Schema.Literal("turn-end"),
		messageId: Schema.String,
		reason: Schema.Literals(["stop", "aborted", "error", "max-steps"]),
		/** Present when `reason` is `"error"`. */
		error: Schema.optionalKey(Schema.String),
		...task,
	},
} as const

const withSeq = <Fields extends Schema.Struct.Fields>(fields: Fields) => ({
	/** Monotonic per session, starting at 1. The reconnect cursor. */
	seq: Schema.Number,
	...fields,
})

export class ChatUserMessageEvent extends Schema.Class<ChatUserMessageEvent>("chat.user-message")(
	withSeq(eventFields["user-message"]),
) {}

export class ChatTurnStartEvent extends Schema.Class<ChatTurnStartEvent>("chat.turn-start")(
	withSeq(eventFields["turn-start"]),
) {}

export class ChatTextDeltaEvent extends Schema.Class<ChatTextDeltaEvent>("chat.text-delta")(
	withSeq(eventFields["text-delta"]),
) {}

export class ChatToolCallEvent extends Schema.Class<ChatToolCallEvent>("chat.tool-call")(
	withSeq(eventFields["tool-call"]),
) {}

export class ChatToolResultEvent extends Schema.Class<ChatToolResultEvent>("chat.tool-result")(
	withSeq(eventFields["tool-result"]),
) {}

export class ChatTurnRetryEvent extends Schema.Class<ChatTurnRetryEvent>("chat.turn-retry")(
	withSeq(eventFields["turn-retry"]),
) {}

export class ChatTurnEndEvent extends Schema.Class<ChatTurnEndEvent>("chat.turn-end")(
	withSeq(eventFields["turn-end"]),
) {}

export const ChatEvent = Schema.Union([
	ChatUserMessageEvent,
	ChatTurnStartEvent,
	ChatTextDeltaEvent,
	ChatToolCallEvent,
	ChatToolResultEvent,
	ChatTurnRetryEvent,
	ChatTurnEndEvent,
]).pipe(Schema.toTaggedUnion("type"))
export type ChatEvent = Schema.Schema.Type<typeof ChatEvent>

/** Distributive `Omit`, so each union member keeps its own discriminated shape. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * A `ChatEvent` before the session assigns it a `seq`. Producers (the agent turn, the submission
 * path) emit this shape; the Durable Object owns ordering and stamps the `seq`.
 */
export type ChatEventInput = DistributiveOmit<ChatEvent, "seq">

/** One SSE frame is exactly one encoded `ChatEvent`; the SSE `id:` field is its `seq`. */
export const encodeChatEvent = Schema.encodeUnknownSync(Schema.fromJsonString(ChatEvent))

/** The throwing decode, for tests and for producers that control both ends of the wire. */
export const decodeChatEventOrThrow = Schema.decodeUnknownSync(Schema.fromJsonString(ChatEvent))

/**
 * Decode one SSE frame, or `undefined` if it is not a `ChatEvent` this build understands.
 *
 * Non-throwing on purpose. A frame that failed to decode used to throw out of the client's read
 * loop, which then reconnected from the cursor *before* the bad frame — so the server replayed it
 * and the client threw again, until the retry budget ran out and the conversation died. Skipping an
 * unrecognised frame instead means adding a new `ChatEvent` member degrades old clients rather than
 * bricking them.
 */
const decodeChatEventOption = Schema.decodeUnknownOption(Schema.fromJsonString(ChatEvent))

export const decodeChatEvent = (frame: string): ChatEvent | undefined =>
	Option.getOrUndefined(decodeChatEventOption(frame))

/**
 * Durable-storage codec for the event log.
 *
 * The log stores an event *without* its `seq` — the SQLite row key is the seq. Going through the
 * schema rather than raw `JSON.parse` + `as ChatEvent` means a shape change surfaces as a decode
 * error at the boundary instead of as a malformed event handed to the transcript fold.
 */
const ChatEventPayload = Schema.Union([
	Schema.Struct(eventFields["user-message"]),
	Schema.Struct(eventFields["turn-start"]),
	Schema.Struct(eventFields["text-delta"]),
	Schema.Struct(eventFields["tool-call"]),
	Schema.Struct(eventFields["tool-result"]),
	Schema.Struct(eventFields["turn-retry"]),
	Schema.Struct(eventFields["turn-end"]),
]).pipe(Schema.toTaggedUnion("type"))

const encodePayload = Schema.encodeUnknownSync(Schema.fromJsonString(ChatEventPayload))
const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(ChatEventPayload))

export const encodeChatEventPayload = (event: ChatEventInput): string => encodePayload(event)

export const decodeChatEventPayload = (payload: string, seq: number): ChatEvent =>
	({ ...decodePayload(payload), seq }) as ChatEvent

// Turn identity

/**
 * The caller identity a turn runs as, in the shape that survives a Durable Object hop.
 *
 * `apps/api`'s own `TenantContext` is the source of truth for authorization, but it is an
 * `apps/api` type and the DO takes this over RPC, so the crossing point needs a declared,
 * serializable shape. The route resolves the real tenant, authorizes it against the session's org,
 * and passes this projection down; the turn re-widens it on the other side.
 */
export const ChatTurnTenant = Schema.Struct({
	orgId: OrgId,
	userId: UserId,
	roles: Schema.Array(RoleName),
	authMode: AuthMode,
	/** Pre-resolved agent identity, when the caller authenticated as one. */
	actorId: Schema.optionalKey(ActorId),
})
export type ChatTurnTenant = Schema.Schema.Type<typeof ChatTurnTenant>

/**
 * The plain, structured-cloneable form that actually crosses the Durable Object boundary.
 *
 * This distinction is load-bearing, not pedantry. Durable Object RPC serializes with structured
 * clone, which refuses class instances outright — a `Schema.Class` here failed every `beginTurn`
 * with `DataCloneError: Could not serialize object of type "ChatTurnTenant"`, while `history()`
 * kept working because it returns object literals. So the schema stays a `Struct` (whose decoded
 * form *is* a plain object) and the crossing is typed as its encoded shape.
 */
export type ChatTurnTenantEncoded = (typeof ChatTurnTenant)["Encoded"]

export const encodeChatTurnTenant = Schema.encodeSync(ChatTurnTenant)
export const decodeChatTurnTenant = Schema.decodeSync(ChatTurnTenant)

/**
 * Who drives this turn, stated rather than inferred.
 *
 * The second axis of a turn, beside {@link ChatMode}: the mode says what the conversation is, the
 * origin says who is pushing it forward. They are independent — a person can follow up inside an
 * investigation, and a connector answers in what is otherwise an ordinary chat conversation — and
 * every behaviour that used to be recovered from a sentinel user id hangs off this instead. A
 * sentinel is an identity being asked a question it cannot answer: `internal-service` is a claim
 * about *how* the turn was raised, wearing the shape of *who* raised it.
 *
 * Set server-side by whoever calls `beginTurn`, which is reachable only from Maple's own Workers.
 * A `Struct` union, not a `Class` one, for the same structured-clone reason as
 * {@link ChatTurnTenant}.
 */
export const ChatTurnOrigin = Schema.Union([
	/** A signed-in person in the Maple app. */
	Schema.Struct({ kind: Schema.Literal("app") }),
	/** An investigation's own unattended pass, which has no reader at all. */
	Schema.Struct({ kind: Schema.Literal("autonomous") }),
	/**
	 * Someone addressing Maple from a chat platform. The identity is the platform's, not Maple's:
	 * there is no user row behind `externalUserId`, and `displayName` is what that platform shows.
	 * The engine reads only `kind`; the rest is what the audit model will attribute a turn by.
	 */
	Schema.Struct({
		kind: Schema.Literal("connector"),
		connectorId: ChatConnectorId,
		workspaceId: Schema.String,
		externalUserId: ExternalUserId,
		displayName: Schema.String,
	}),
])
/**
 * Plain data on both sides, so it crosses the Durable Object boundary as itself — every field is
 * a string, so unlike {@link ChatTurnTenant} there is nothing to rebuild on arrival.
 */
export type ChatTurnOrigin = (typeof ChatTurnOrigin)["Encoded"]

/**
 * The user id a connector turn's tenant carries.
 *
 * `TenantContext` requires one and no Maple user stands behind a connector turn, so this is a
 * placeholder to satisfy that type — **nothing branches on it**. Every behavioural question is
 * answered by {@link ChatTurnOrigin}.
 */
export const CONNECTOR_TENANT_USER_ID = Schema.decodeSync(UserId)("chat-connector")

/**
 * The turn identity a connector Worker hands `beginTurn`, already encoded for the DO hop.
 *
 * No roles: a connector turn proposes mutations rather than performing them, so the only reader of
 * roles — the authorization check inside a mutating tool — is reached by the apply path, under
 * whoever approved the proposal, not by the turn that wrote it.
 */
export const connectorTurnTenant = (orgId: OrgId): ChatTurnTenantEncoded =>
	encodeChatTurnTenant({
		orgId,
		userId: CONNECTOR_TENANT_USER_ID,
		roles: [],
		authMode: "self_hosted",
	})

const ORG_ADMIN_ROLE = Schema.decodeSync(RoleName)("org:admin")

/**
 * The identity an approved proposal runs under **on a connector that cannot say who clicked**.
 * See `ChatConnector.identity` for the three-case approval policy this is half of.
 *
 * The role is granted at apply time only — the turn that WROTE the proposal carried none, which is
 * what makes the approval gate mean anything. Deliberately beside {@link connectorTurnTenant}:
 * the two are one rule read together.
 */
export const connectorApprovalTenant = (orgId: OrgId): ChatTurnTenantEncoded =>
	encodeChatTurnTenant({
		orgId,
		userId: CONNECTOR_TENANT_USER_ID,
		roles: [ORG_ADMIN_ROLE],
		authMode: "self_hosted",
	})

/** Which connector, and who on it — the member of {@link ChatTurnOrigin} an approval carries. */
export type ChatConnectorOrigin = Extract<ChatTurnOrigin, { readonly kind: "connector" }>

/**
 * What a click on an approval control asks for.
 *
 * Through a schema because the decision is read back off an untrusted control id: the members are
 * derived from one declaration, so a third one cannot be added to the type while the parser that
 * matches them silently keeps looking for two.
 */
export const ChatProposalDecision = Schema.Literals(["approve", "deny"])
export type ChatProposalDecision = Schema.Schema.Type<typeof ChatProposalDecision>

/** Every decision there is, for a caller that has to match a wire value against them. */
export const CHAT_PROPOSAL_DECISIONS = ChatProposalDecision.literals

/** Everything the session needs to settle a proposal: which call, which way, and who said so. */
export interface ChatProposalSettlement {
	/** `"<orgId>:<tabId>"`. A Durable Object cannot recover its own name, exactly as for `beginTurn`. */
	readonly sessionId: string
	readonly toolCallId: string
	readonly decision: ChatProposalDecision
	readonly approver: ChatConnectorOrigin
	/**
	 * The Maple user the approver's chat account is linked to, resolved by the host from its own
	 * database — never from anything the click carried.
	 *
	 * Present means the change runs as that user, under the roles they hold in the org at that
	 * moment. Absent means the connector cannot prove who clicked, and the org-level connector
	 * identity acts instead ({@link connectorApprovalTenant}).
	 */
	readonly actingUserId?: UserId
}

/**
 * What settling answered.
 *
 * A bare string because that is all the caller can act on: it re-reads the transcript for what the
 * decision actually produced. `"settled"` is the second click on the same control — someone else
 * got there first, or the same person clicked twice — and is a no-op by design.
 */
export type ChatProposalOutcome = "unknown" | "settled" | "decided"

/**
 * The origin of a turn raised through Maple's own HTTP surface.
 *
 * That route authenticates a signed-in person and Maple's own service token alike, and the only
 * thing that distinguishes them is the user id the auth layer stamped on the caller — so the read
 * lives here rather than in the route, and an unattended pass cannot become attended by being
 * restarted from a different place.
 */
export const originForTenant = (tenant: ChatTurnTenantEncoded): ChatTurnOrigin => ({
	kind: tenant.userId === "internal-service" ? "autonomous" : "app",
})

// Requests

export class ChatSendRequest extends Schema.Class<ChatSendRequest>("@maple/ChatSendRequest")({
	/** The full message text, with any client-side context preamble already folded in. */
	text: Schema.String,
}) {}

export class ChatSendResponse extends Schema.Class<ChatSendResponse>("@maple/ChatSendResponse")({
	/** Cursor immediately BEFORE this submission's first event, so no event is missed. */
	cursor: Schema.Number,
	messageId: Schema.String,
}) {}
