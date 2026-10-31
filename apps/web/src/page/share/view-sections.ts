import { cn } from "@maple/ui/lib/utils"
import type { DashboardSection } from "@maple/widgets/dashboard"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../ui/empty"
import { icon } from "../../ui/icon"
import { iconButton } from "../../ui/icon-button"
import { Message } from "./message"

// `DashboardSectionView` with `readOnly`: the chevron, the title and the tabs, no editing; the classes are
// the editable header's.

type H = HtmlBuilder<Message>

const tabBar = (h: H, section: DashboardSection, activeTabId: string): Html =>
	h.div(
		[h.Class("flex min-w-0 items-center gap-1 overflow-x-auto"), h.Role("tablist")],
		section.tabs.map((tab) => {
			const isActive = tab.id === activeTabId
			return h.keyed("div")(
				tab.id,
				[
					h.Class(
						cn(
							"group/tab flex shrink-0 items-center gap-1 border-b-2 px-2 py-1 text-xs transition-colors",
							isActive
								? "border-primary text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground active:text-foreground",
						),
					),
				],
				[
					h.button(
						[
							h.Type("button"),
							h.Role("tab"),
							h.AriaSelected(isActive),
							h.OnClick(Message.ClickedSectionTab({ sectionId: section.id, tabId: tab.id })),
							h.Class("min-w-0 max-w-48 cursor-pointer font-medium outline-none"),
						],
						[h.span([h.Class("block truncate text-xs font-medium"), h.Title(tab.title)], [tab.title])],
					),
				],
			)
		}),
	)

export type SharedSectionInputs = Readonly<{
	section: DashboardSection
	activeTabId: string
	isCollapsed: boolean
	/** The active tab's grid, or `null` when it holds no widgets. */
	grid: Html | null
}>

/** One group of a shared board: a collapsed one draws its header only, so its tiles never fetch. */
export const sharedSection = (h: H, { section, activeTabId, isCollapsed, grid }: SharedSectionInputs): Html => {
	const hasTabs = section.tabs.length >= 2
	return h.keyed("section")(
		section.id,
		[h.Class("mb-2")],
		[
			h.div(
				[h.Class("flex items-center gap-2 border-b py-2")],
				[
					section.collapsible !== false
						? iconButton(
								h,
								{
									size: "icon-xs",
									label: isCollapsed ? `Expand ${section.title}` : `Collapse ${section.title}`,
									attributes: [
										h.AriaExpanded(!isCollapsed),
										h.OnClick(Message.ClickedSectionChevron({ sectionId: section.id, collapsed: !isCollapsed })),
									],
								},
								[
									icon(h, "ChevronDownIcon", {
										className: cn("transition-transform duration-150", isCollapsed && "-rotate-90"),
									}),
								],
							)
						: h.div([h.Class("size-6 shrink-0"), h.AriaHidden(true)]),
					h.span([h.Class("min-w-0 truncate text-sm font-semibold"), h.Title(section.title)], [section.title]),
					...(hasTabs && !isCollapsed
						? [h.div([h.Class("ml-2 min-w-0 flex-1")], [tabBar(h, section, activeTabId)])]
						: []),
					h.div([h.Class(cn("flex items-center gap-1", !hasTabs && "ml-auto"))], []),
				],
			),
			...(isCollapsed
				? []
				: [
						grid === null
							? emptyMessage(h, { className: "px-1 py-6 text-left" }, ["This group is empty."])
							: h.div([h.Class("pt-2")], [grid]),
					]),
		],
	)
}
