/**
 * The handle an approval button carries, and the only thing a connector has to round-trip.
 *
 * A platform gives a button a small string and hands it back when someone clicks — 100 characters
 * on the tightest of them — so the token is the pair that identifies the pending call and nothing
 * else: which session, which tool call. Who is allowed to click is decided by the connector's own
 * authorization when the click arrives, never by what the button carries.
 */
import { ChatSessionId, orgIdFromChatSessionId } from "@maple/domain/chat-session"
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
 * Read a token back, or `undefined` for anything that is not one.
 *
 * The button's string arrives from the platform, so it is untrusted input: a session id carrying no
 * resolvable org is rejected here, rather than reaching a caller that would look the org up from it.
 */
export const decodeChatActionToken = (token: string): ChatAction | undefined => {
	const separator = token.indexOf(SEPARATOR)
	if (separator <= 0) return undefined
	const rawSessionId = token
		.slice(0, separator)
		.replaceAll(ESCAPED_SEPARATOR, SEPARATOR)
		.replaceAll(ESCAPED_ESCAPE, ESCAPE)
	const toolCallId = token.slice(separator + SEPARATOR.length)
	if (toolCallId.length === 0 || orgIdFromChatSessionId(rawSessionId) === undefined) return undefined
	// Through the schema rather than a cast: `ChatSessionId` carries no checks today, and the day it
	// does, a button's string must fail here rather than become a branded id later code trusts.
	const sessionId = decodeSessionId(rawSessionId)
	return Option.isNone(sessionId) ? undefined : { sessionId: sessionId.value, toolCallId }
}
