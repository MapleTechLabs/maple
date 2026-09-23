/**
 * The handle an approval button carries, and the only thing a connector has to round-trip.
 *
 * A platform gives a button a small string and hands it back when someone clicks — 100 characters
 * on the tightest of them — so a control carries the decision it stands for plus the pair that
 * identifies the pending call, and nothing else: which session, which tool call.
 *
 * Who is allowed to click is NOT in here and is not the connector's call either. Ingress reports
 * only who clicked (`InboundActor`), and the vendor-neutral host decides from that — see
 * `ChatConnector.identity`. A forged control can therefore name any call it likes; it cannot name
 * a verdict.
 */
import {
	CHAT_PROPOSAL_DECISIONS,
	ChatSessionId,
	orgIdFromChatSessionId,
	type ChatProposalDecision,
} from "@maple/domain/chat-session"
import { Option, Schema } from "effect"

export const ChatActionToken = Schema.String.pipe(Schema.brand("@maple/ChatActionToken"))
export type ChatActionToken = typeof ChatActionToken.Type

const asActionToken = Schema.decodeSync(ChatActionToken)
const decodeSessionId = Schema.decodeUnknownOption(ChatSessionId)

/**
 * The two halves join on `|`, and the split takes the FIRST one — a tool call id is
 * provider-assigned and may well contain one, a session id must not.
 *
 * "Must not" is enforced rather than assumed: `ChatSessionId` is a bare brand, its tab half is
 * whatever minted the session, and a session id carrying a `|` would otherwise decode back as a
 * SHORTER session id that still looks valid — the wrong conversation, silently.
 */
const SEPARATOR = "|"
const ESCAPE = "%"
const ESCAPED_SEPARATOR = "%7C"
const ESCAPED_ESCAPE = "%25"

export const encodeChatActionToken = (sessionId: ChatSessionId, toolCallId: string): ChatActionToken =>
	asActionToken(
		// The marker goes first and comes back last: a session id already containing `%7C` would
		// otherwise decode to a `|` it never had — a different session that still looks valid.
		`${sessionId.replaceAll(ESCAPE, ESCAPED_ESCAPE).replaceAll(SEPARATOR, ESCAPED_SEPARATOR)}` +
			`${SEPARATOR}${toolCallId}`,
	)

export interface ChatAction {
	readonly sessionId: ChatSessionId
	readonly toolCallId: string
}

/**
 * Read a token back. `None` for anything that is not one.
 *
 * The button's string arrives from the platform, so it is untrusted input: a session id carrying no
 * resolvable org is rejected here, rather than reaching a caller that would look the org up from it.
 */
export const decodeChatActionToken = (token: string): Option.Option<ChatAction> => {
	const separator = token.indexOf(SEPARATOR)
	if (separator <= 0) return Option.none()
	const rawSessionId = token
		.slice(0, separator)
		.replaceAll(ESCAPED_SEPARATOR, SEPARATOR)
		.replaceAll(ESCAPED_ESCAPE, ESCAPE)
	const toolCallId = token.slice(separator + SEPARATOR.length)
	if (toolCallId.length === 0 || orgIdFromChatSessionId(rawSessionId) === undefined) {
		return Option.none()
	}
	// Through the schema rather than a cast: `ChatSessionId` carries no checks today, and the day it
	// does, a button's string must fail here rather than become a branded id later code trusts.
	return Option.map(decodeSessionId(rawSessionId), (sessionId) => ({ sessionId, toolCallId }))
}

/**
 * The whole string one control carries: the decision it stands for, then the token.
 *
 * Here rather than inside a connector because both ends have to agree on it — a connector mints
 * the control and hands its string back verbatim, and the host reads the decision off it. A
 * connector that wrote its own prefix would be a second spelling of the same convention, and the
 * host has no way to tell a mis-spelled one from a forged one.
 *
 * The decision goes FIRST so the split is unambiguous: a session id contains `:` and a tool call
 * id may, while `approve` and `deny` contain neither.
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
