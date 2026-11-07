import { cn } from "@maple/ui/lib/utils"
import type { DashboardSection } from "@maple/widgets/dashboard"
import type { Html, HtmlBuilder } from "foldkit/html"
import { pressable } from "@maple/views/ui/pressable"
import { emptyMessage } from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { Message } from "./message"
import { hstack, hstackClass } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { typography } from "@maple/views/ui/typography"

// `DashboardSectionView` with `readOnly`: the chevron, the title and the tabs, no editing; the classes are
// the editable header's.

type H = HtmlBuilder<Message>

const tabBar = (h: H, section: DashboardSection, activeTabId: string): Html =>
	hstack(
		h,
		{
			gap: "1",
			align: "center",
			shrink: true,
			className: "overflow-x-auto",
			attributes: [h.Role("tablist")],
		},
		Arr.map(section.tabs, (tab) => {
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
					pressable(
						h,
						{
							onClick: Message.ClickedSectionTab({ sectionId: section.id, tabId: tab.id }),
							className: "min-w-0 max-w-48 font-medium outline-none",
							attributes: [h.Role("tab"), h.AriaSelected(isActive)],
						},
						[
							typography(
								h,
								{
									size: "xs",
									weight: "medium",
									truncate: true,
									className: "block",
									attributes: [h.Title(tab.title)],
								},
								[tab.title],
							),
						],
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
export const sharedSection = (
	h: H,
	{ section, activeTabId, isCollapsed, grid }: SharedSectionInputs,
): Html => {
	const hasTabs = section.tabs.length >= 2
	return h.keyed("section")(
		section.id,
		[h.Class("mb-2")],
		[
			hstack(h, { gap: "2", align: "center", className: "border-b py-2" }, [
				section.collapsible !== false
					? iconButton(
							h,
							{
								size: "icon-xs",
								label: isCollapsed ? `Expand ${section.title}` : `Collapse ${section.title}`,
								attributes: [
									h.AriaExpanded(!isCollapsed),
									h.OnClick(
										Message.ClickedSectionChevron({
											sectionId: section.id,
											collapsed: !isCollapsed,
										}),
									),
								],
							},
							[
								icon(h, "ChevronDownIcon", {
									className: cn(
										"transition-transform duration-150",
										isCollapsed && "-rotate-90",
									),
								}),
							],
						)
					: h.div([h.Class("size-6 shrink-0"), h.AriaHidden(true)]),
				typography(
					h,
					{
						size: "sm",
						weight: "semibold",
						truncate: true,
						className: "min-w-0",
						attributes: [h.Title(section.title)],
					},
					[section.title],
				),
				...(hasTabs && !isCollapsed
					? [h.div([h.Class("ml-2 min-w-0 flex-1")], [tabBar(h, section, activeTabId)])]
					: []),
				h.div([h.Class(cn(hstackClass({ gap: "1" }), !hasTabs && "ml-auto"))], []),
			]),
			...(isCollapsed
				? []
				: [
						grid === null
							? emptyMessage(h, { className: "px-1 py-6 text-left" }, ["This group is empty"])
							: h.div([h.Class("pt-2")], [grid]),
					]),
		],
	)
}
