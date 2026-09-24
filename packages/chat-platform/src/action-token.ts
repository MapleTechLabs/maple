/**
 * The handle an approval button carries, and the only thing a connector has to round-trip.
 *
 * A platform gives a button a small string and hands it back when someone clicks — 100 characters
 * on the tightest of them — so a control carries the decision it stands for plus the tool call it
 * answers, and nothing else.
 *
 * Not the session. The host rebuilds that from where the click landed — the org that owns the
 * workspace and the conversation the connector names — so carrying it too would only spend the
 * budget: an org id and a platform's thread id came to 101 characters with the call id, and the
 * connector dropped the buttons. It also means a control cannot reach outside the conversation it
 * was clicked in, forged or not.
 *
 * Who is allowed to click is NOT in here and is not the connector's call either. Ingress reports
 * only who clicked (`InboundActor`), and the vendor-neutral host decides from that — see
 * `ChatConnector.identity`. A forged control can therefore name any call in its own conversation;
 * it cannot name a verdict.
 */
import { CHAT_PROPOSAL_DECISIONS, type ChatProposalDecision } from "@maple/domain/chat-session"
import { Option, Schema } from "effect"

export const ChatActionToken = Schema.String.pipe(Schema.brand("@maple/ChatActionToken"))
export type ChatActionToken = typeof ChatActionToken.Type

const asActionToken = Schema.decodeSync(ChatActionToken)

export const encodeChatActionToken = (toolCallId: string): ChatActionToken => asActionToken(toolCallId)

export interface ChatAction {
	readonly toolCallId: string
}

/** Read a token back. `None` for anything that is not one. */
export const decodeChatActionToken = (token: string): Option.Option<ChatAction> =>
	token.length === 0 ? Option.none() : Option.some({ toolCallId: token })

/**
 * The whole string one control carries: the decision it stands for, then the token.
 *
 * Here rather than inside a connector because both ends have to agree on it — a connector mints
 * the control and hands its string back verbatim, and the host reads the decision off it. A
 * connector that wrote its own prefix would be a second spelling of the same convention, and the
 * host has no way to tell a mis-spelled one from a forged one.
 *
 * The decision goes FIRST so the split is unambiguous: a tool call id may contain `:`, while
 * `approve` and `deny` contain neither.
 */
const DECISION_SEPARATOR = ":"

export const chatActionControlId = (decision: ChatProposalDecision, token: ChatActionToken): string =>
	`${decision}${DECISION_SEPARATOR}${token}`

export interface ChatActionRequest extends ChatAction {
	readonly decision: ChatProposalDecision
}

/**
 * Read a control's string back. `None` for anything that is not one of Maple's.
 *
 * A platform hands back whatever was on the control that was clicked, which on some of them
 * includes controls Maple never rendered — so "not ours" is an ordinary answer here, not a failure.
 */
export const decodeChatActionControlId = (raw: string): Option.Option<ChatActionRequest> =>
	Option.flatMap(chatActionDecision(raw), (decision) =>
		Option.map(
			decodeChatActionToken(raw.slice(decision.length + DECISION_SEPARATOR.length)),
			(action) => ({ ...action, decision }),
		),
	)

/**
 * The decision a control's string stands for, if it is shaped like one of Maple's at all.
 *
 * Separate from the full decode so a caller can tell the two apart: a control carrying no decision
 * is somebody else's, while one that names a decision and then fails to decode is a Maple control
 * that was forged or corrupted — which is worth a line in the log, not silence.
 */
export const chatActionDecision = (raw: string): Option.Option<ChatProposalDecision> =>
	Option.fromUndefinedOr(
		CHAT_PROPOSAL_DECISIONS.find((candidate) => raw.startsWith(`${candidate}${DECISION_SEPARATOR}`)),
	)
