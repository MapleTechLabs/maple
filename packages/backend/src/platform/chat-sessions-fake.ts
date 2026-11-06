/**
 * A `ChatSessions` port for tests: each session answers with the methods a test fakes, and a
 * call to any other fails, so a test that reaches further than it meant to says so.
 */
import { type ChatSessionStub, chatSessionClientFromStub } from "@maple/domain/chat-session-stub"
import { Layer } from "effect"
import { ChatSessions, type ChatSessionsApi } from "./bindings"

const notFaked = (method: string) => () => Promise.reject(`ChatSession.${method} is not faked in this test`)

const unfaked: ChatSessionStub = {
	cursor: notFaked("cursor"),
	running: notFaked("running"),
	history: notFaked("history"),
	since: notFaked("since"),
	subscribe: notFaked("subscribe"),
	append: notFaked("append"),
	beginTurn: notFaked("beginTurn"),
	settleProposal: notFaked("settleProposal"),
	holdsTurn: notFaked("holdsTurn"),
	endTurn: notFaked("endTurn"),
	abort: notFaked("abort"),
}

export const fakeChatSessions = (
	session: (sessionId: string) => Partial<ChatSessionStub>,
): ChatSessionsApi => ({
	session: (sessionId) => chatSessionClientFromStub({ ...unfaked, ...session(sessionId) }),
})

export const fakeChatSessionsLayer = (session: (sessionId: string) => Partial<ChatSessionStub>) =>
	Layer.succeed(ChatSessions, fakeChatSessions(session))
