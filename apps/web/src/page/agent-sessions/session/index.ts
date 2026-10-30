import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/agent-sessions/$sessionId`: one session's four views. One instance per session. */
export const entry = definePage(
	"AgentSession",
	{ Model, Message },
	{ routes: ["AgentSession"], key: (route) => `AgentSession:${route.sessionId}` },
)

export const page = entry.lazy(pageCode.AgentSession)
