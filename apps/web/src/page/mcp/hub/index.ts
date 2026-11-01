import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/mcp-servers`, a server's overview and its tool pages, as one instance: the time range carries across. */
export const page = definePage(
	"McpServers",
	{ Model, Message },
	{
		routes: ["McpServers", "McpServer", "McpServerTool"],
		key: () => "mcp-servers",
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) =>
			model.view._tag === "Servers"
				? [{ label: "MCP servers", isPageHeading: true }]
				: model.view._tag === "Server"
					? [{ label: "MCP servers", href: "/mcp-servers" }, { label: model.view.service }]
					: [
							{ label: "MCP servers", href: "/mcp-servers" },
							{
								label: model.view.service,
								href: `/mcp-servers/${encodeURIComponent(model.view.service)}`,
							},
							{ label: model.view.tool },
						],
	},
)
