import { investigationIdFromChatSessionId } from "@maple/domain/chat-session"
import { InvestigationId } from "@maple/domain/primitives"
import { Option, Schema } from "effect"

const decodeInvestigationId = Schema.decodeUnknownOption(InvestigationId)

/** One address decoder for report submission and billing of existing investigation sessions. */
export const investigationIdForSession = (sessionId: string): InvestigationId | undefined => {
	const rawId = investigationIdFromChatSessionId(sessionId)
	return rawId === undefined ? undefined : Option.getOrUndefined(decodeInvestigationId(rawId))
}
