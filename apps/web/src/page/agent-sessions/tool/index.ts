import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/agent-sessions/tools/$toolName`: one tool's charts, failures and sessions. One instance per tool. */
export const entry = definePage(
	"AgentSessionTool",
	{ Model, Message },
	{ routes: ["AgentSessionTool"], key: (route) => `AgentSessionTool:${route.toolName}` },
)

export const page = entry.lazy(pageCode.AgentSessionTool)
