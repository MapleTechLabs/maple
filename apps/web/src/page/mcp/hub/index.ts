import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/mcp-servers`, a server's overview, its tool pages and its sessions, as one instance: the time range carries across. */
export const page = definePage(
	"McpServers",
	{ Model, Message },
	{
		routes: ["McpServers", "McpServer", "McpServerTool", "McpServerSessions", "McpServerSession"],
		key: () => "mcp-servers",
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) => {
			const { view } = model
			const servers = { label: "MCP servers", href: "/mcp-servers" }
			if (view._tag === "Servers") return [{ label: "MCP servers", isPageHeading: true }]
			const server = `/mcp-servers/${encodeURIComponent(view.service)}`
			switch (view._tag) {
				case "Server":
					return [servers, { label: view.service }]
				case "Tool":
					return [servers, { label: view.service, href: server }, { label: view.tool }]
				case "Sessions":
					return [servers, { label: view.service, href: server }, { label: "Sessions" }]
				case "Session":
					return [
						servers,
						{ label: view.service, href: server },
						{ label: "Sessions", href: `${server}/sessions` },
						{ label: view.sessionId },
					]
			}
		},
	},
)
