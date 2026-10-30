import type { McpToolCatalogEntry } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import { groupMcpTools, type McpToolGroup } from "../../../components/mcp/mcp-tool-groups"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { searchInput } from "../../../ui/search-input"
import { skeletonList } from "../../../ui/skeleton"
import { sectionNote, settingsSection } from "../kit/section"
import { Message } from "./message"
import type { Model } from "./model"
import { emptyMessage } from "../../../ui/empty"

// `McpToolsList`.

type H = HtmlBuilder<Message>

const OPEN_GROUPS = 3
const PREVIEW_ROWS = 4

const toolRow = (h: H, tool: McpToolCatalogEntry): Html =>
	h.li(
		[
			h.Key(tool.name),
			h.Class(
				"grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] items-center gap-4 py-1.5 max-sm:grid-cols-[minmax(0,1fr)_auto]",
			),
		],
		[
			h.code([h.Class("truncate font-mono text-xs font-medium text-foreground")], [tool.name]),
			h.p(
				[h.Class("truncate text-xs text-muted-foreground max-sm:hidden"), h.Title(tool.description)],
				[tool.description],
			),
			tool.readOnly
				? badge(h, { variant: "muted", size: "sm" }, ["Read only"])
				: badge(h, { variant: "warn", size: "sm" }, ["Writes"]),
		],
	)

const toolGroup = (h: H, group: McpToolGroup, isOpen: boolean, isShowingAll: boolean): Html => {
	const hidden = isShowingAll ? 0 : Math.max(0, group.tools.length - PREVIEW_ROWS)
	const rows = hidden === 0 ? group.tools : group.tools.slice(0, PREVIEW_ROWS)
	const panelId = `mcp-tools-${group.id}-panel`
	return h.div(
		[
			h.Key(group.id),
			h.DataAttribute(isOpen ? "open" : "closed", ""),
			h.DataAttribute("slot", "collapsible"),
		],
		[
			h.button(
				[
					...(isOpen ? [h.AriaControls(panelId)] : []),
					h.AriaDisabled(false),
					h.AriaExpanded(isOpen),
					h.Class("flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-muted/50"),
					...(isOpen ? [h.DataAttribute("panel-open", "")] : []),
					h.DataAttribute("slot", "collapsible-trigger"),
					h.Tabindex(0),
					h.Type("button"),
					h.OnClick(Message.ToggledToolGroup({ groupId: group.id })),
				],
				[
					icon(h, "ChevronRightIcon", {
						size: 14,
						className: cn(
							"shrink-0 text-muted-foreground transition-transform",
							isOpen && "rotate-90",
						),
					}),
					h.span([h.Class("font-medium")], [group.label]),
					h.span(
						[h.Class("text-xs text-muted-foreground tabular-nums")],
						[String(group.tools.length)],
					),
				],
			),
			...(isOpen
				? [
						h.div(
							[
								h.Class(collapsiblePanelStyles),
								h.DataAttribute("open", ""),
								h.DataAttribute("slot", "collapsible-panel"),
								h.Id(panelId),
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
									"animation-name": "none",
								}),
							],
							[
								h.div(
									[h.Class("px-4 pb-3 pl-10")],
									[
										h.ul(
											[],
											rows.map((tool) => toolRow(h, tool)),
										),
										...(hidden > 0
											? [
													button(
														h,
														{
															variant: "ghost",
															size: "xs",
															className: "-ml-2 mt-1 text-muted-foreground",
															attributes: [
																h.OnClick(
																	Message.ClickedShowAllTools({
																		groupId: group.id,
																	}),
																),
															],
														},
														["Show ", String(hidden), " more"],
													),
												]
											: []),
									],
								),
							],
						),
					]
				: []),
		],
	)
}

const catalog = (h: H, model: Model, tools: ReadonlyArray<McpToolCatalogEntry>): ReadonlyArray<Html> => {
	const isSearching = model.toolSearch.trim() !== ""
	const groups = groupMcpTools(tools, model.toolSearch)
	return [
		h.div(
			[h.Class("border-b p-2")],
			[
				searchInput(h, {
					id: "mcp-tools-search",
					value: model.toolSearch,
					onInput: (value) => Message.ChangedToolSearch({ value }),
					onClear: Message.ClickedClearToolSearch(),
					placeholder: `Search ${tools.length} tools`,
					ariaLabel: "Search tools",
				}),
			],
		),
		groups.length === 0
			? emptyMessage(h, {}, ["No tools match “", model.toolSearch, "”."])
			: h.div(
					[h.Class("divide-y")],
					groups.map((group, index) =>
						toolGroup(
							h,
							group,
							isSearching || index < OPEN_GROUPS !== model.flippedGroups.includes(group.id),
							isSearching || model.expandedGroups.includes(group.id),
						),
					),
				),
	]
}

export const toolsSection = (h: H, model: Model): Html => {
	const count = AsyncData.getOrElse(
		AsyncData.map(model.tools, (tools) => tools.length),
		() => null,
	)
	return settingsSection(
		h,
		{
			id: "mcp-tools-heading",
			title: count === null ? "Tools" : `Tools · ${count}`,
			description: ["What a connected client can do. Tools marked Writes change data."],
			padded: false,
		},
		AsyncData.matchData(model.tools, {
			onEmpty: () => [h.div([h.Class("p-4")], [skeletonList(h, { rows: 6 })])],
			onFailure: () => [sectionNote(h, "Couldn't load the tool list.")],
			onData: (tools) => catalog(h, model, tools),
		}),
	)
}
