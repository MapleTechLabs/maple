/**
 * MCP session transcripts, so the next isolate can find a session this one
 * issued. Declared at module scope; the Worker binds it in its props.
 */
import { stageProps } from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"

export const McpSessions = Cloudflare.KV.Namespace(
	"MCP_SESSIONS",
	stageProps("mcp-sessions", (title) => ({ title })),
)
