import type { DashboardDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import { button } from "../../../ui/button"
import { emptyMessage } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import * as Menu from "../../../ui/menu"
import type * as MenuView from "../../../ui/menu-view"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { countLabel } from "@maple/ui/lib/format"
import { Message } from "./message"
import type { Model } from "./model"
import { sectionMenuIdOf } from "./section-update"

// A dashboard section's header, `SectionTabBar` and
// `InlineEditableText`: the chevron, the renamable title, the tabs, "+" and the options menu.

type H = HtmlBuilder<Message>
type Section = NonNullable<DashboardDocument["sections"]>[number]

/** `InlineEditableText`: a span that renames on double-click, Enter or F2, else the input. */
export const inlineEditableText = (
	h: H,
	model: Model,
	options: Readonly<{
		sectionId: string
		tabId: string | null
		value: string
		ariaLabel: string
		isEditable: boolean
		isFocusable: boolean
		className: string
	}>,
): Html => {
	const rename = model.rename
	if (options.isEditable && rename !== null && rename.sectionId === options.sectionId && rename.tabId === options.tabId)
		return h.input([
			h.Value(rename.draft),
			h.AriaLabel(options.ariaLabel),
			h.Class(
				cn(
					"min-w-0 border-b border-foreground/20 bg-transparent outline-none focus:border-foreground/50",
					options.className,
				),
			),
			h.Autofocus(true),
			h.OnInput((value) => Message.ChangedRenameDraft({ value })),
			h.OnBlur(Message.SubmittedRename()),
			h.OnKeyDownPreventDefault((key) =>
				key === "Enter"
					? Option.some(Message.SubmittedRename())
					: key === "Escape"
						? Option.some(Message.CancelledRename())
						: Option.none(),
			),
		])
	const start = Message.StartedRename({ sectionId: options.sectionId, tabId: options.tabId })
	const keyboardRename = options.isEditable && options.isFocusable
	return h.span(
		[
			h.Class(cn(options.className, options.isEditable && "cursor-text")),
			h.Title(options.isEditable ? `${options.value}\nDouble-click to rename` : options.value),
			...(options.isEditable ? [h.OnDoubleClick(start)] : []),
			...(keyboardRename
				? [
						h.Tabindex(0),
						h.Role("button"),
						h.AriaLabel(options.ariaLabel),
						h.OnKeyDownPreventDefault((key) =>
							key === "Enter" || key === "F2" ? Option.some(start) : Option.none(),
						),
					]
				: []),
		],
		[options.value],
	)
}

/** `SectionTabBar`: the underline tabs of a group with two or more. */
const tabBar = (h: H, model: Model, section: Section, activeTabId: string, isEditable: boolean): Html =>
	h.div(
		[h.Class("flex min-w-0 items-center gap-1 overflow-x-auto"), h.Role("tablist")],
		[
			...section.tabs.map((tab) => {
				const isActive = tab.id === activeTabId
				return h.keyed("div")(
					tab.id,
					[
						h.Class(
							cn(
								"group/tab flex shrink-0 items-center gap-1 border-b-2 px-2 py-1 text-xs transition-colors",
								isActive
									? "border-primary text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground",
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
								...(isEditable
									? [
											h.AriaKeyshortcuts("F2"),
											h.OnKeyDownPreventDefault((key) =>
												key === "F2"
													? Option.some(Message.StartedRename({ sectionId: section.id, tabId: tab.id }))
													: Option.none(),
											),
										]
									: []),
								h.Class("min-w-0 max-w-48 cursor-pointer font-medium outline-none"),
							],
							[
								inlineEditableText(h, model, {
									sectionId: section.id,
									tabId: tab.id,
									value: tab.title,
									ariaLabel: `Rename tab ${tab.title}`,
									isEditable,
									isFocusable: false,
									className: "block truncate text-xs font-medium",
								}),
							],
						),
						...(isEditable && section.tabs.length > 1
							? [
									iconButton(
										h,
										{
											size: "icon-xs",
											label: `Delete tab ${tab.title}`,
											className:
												"opacity-0 transition-opacity focus-visible:opacity-100 group-hover/tab:opacity-100 pointer-coarse:opacity-100",
											attributes: [
												h.OnClick(Message.ClickedDeleteTab({ sectionId: section.id, tabId: tab.id })),
											],
										},
										[icon(h, "TrashIcon")],
									),
								]
							: []),
					],
				)
			}),
			...(isEditable
				? [
						iconButton(
							h,
							{
								size: "icon-xs",
								label: "Add tab",
								className: "shrink-0 text-muted-foreground",
								attributes: [h.OnClick(Message.ClickedAddTab({ sectionId: section.id }))],
							},
							[icon(h, "PlusIcon")],
						),
					]
				: []),
		],
	)

const optionEntries = (
	h: H,
	section: Section,
	index: number,
	sectionCount: number,
): ReadonlyArray<MenuView.MenuEntry> => {
	const isCollapsible = section.collapsible !== false
	return [
		{ _tag: "Item", value: "add-tab", label: "Add tab", icon: "PlusIcon" },
		{ _tag: "Item", value: "move-up", label: "Move up", icon: "ArrowUpIcon", isDisabled: index === 0 },
		{
			_tag: "Item",
			value: "move-down",
			label: "Move down",
			isDisabled: index === sectionCount - 1,
			content: [icon(h, "ArrowUpIcon", { className: "rotate-180" }), "Move down"],
		},
		{ _tag: "Separator" },
		...(isCollapsible
			? [
					{
						_tag: "Item",
						value: "collapsed-default",
						label: section.collapsed === true ? "Expanded by default" : "Collapsed by default",
					} as const,
				]
			: []),
		{ _tag: "Item", value: "collapsible", label: isCollapsible ? "Always expanded" : "Allow collapsing" },
		{ _tag: "Separator" },
		{ _tag: "Item", value: "delete", label: "Delete group…", icon: "TrashIcon", variant: "destructive" },
	]
}

export type SectionViewInputs = Readonly<{
	section: Section
	index: number
	sectionCount: number
	activeTabId: string
	isCollapsed: boolean
	isEditable: boolean
	/** The active tab's grid, or `null` when it holds no widgets. */
	grid: Html | null
}>

/** One collapsible widget group: a collapsed one renders its header only (nothing fetches). */
export const sectionView = (h: H, model: Model, inputs: SectionViewInputs): Html => {
	const { section, isCollapsed, isEditable, activeTabId } = inputs
	const hasTabs = section.tabs.length >= 2
	const isCollapsible = section.collapsible !== false
	return h.keyed("section")(
		section.id,
		[h.Class("mb-2")],
		[
			h.div(
				[h.Class("flex items-center gap-2 border-b py-2")],
				[
					isCollapsible
						? iconButton(
								h,
								{
									size: "icon-xs",
									label: isCollapsed ? `Expand ${section.title}` : `Collapse ${section.title}`,
									attributes: [
										h.AriaExpanded(!isCollapsed),
										h.OnClick(
											Message.ClickedSectionChevron({ sectionId: section.id, collapsed: !isCollapsed }),
										),
									],
								},
								[
									icon(h, "ChevronDownIcon", {
										className: cn("transition-transform duration-150", isCollapsed && "-rotate-90"),
									}),
								],
							)
						: h.div([h.Class("size-6 shrink-0"), h.AriaHidden(true)]),
					inlineEditableText(h, model, {
						sectionId: section.id,
						tabId: null,
						value: section.title,
						ariaLabel: `Rename group ${section.title}`,
						isEditable,
						isFocusable: true,
						className: "min-w-0 truncate text-sm font-semibold",
					}),
					...(hasTabs && !isCollapsed
						? [h.div([h.Class("ml-2 min-w-0 flex-1")], [tabBar(h, model, section, activeTabId, isEditable)])]
						: []),
					h.div(
						[h.Class(cn("flex items-center gap-1", !hasTabs && "ml-auto"))],
						[
							...(isEditable && !isCollapsed
								? [
										iconButton(
											h,
											{
												size: "icon-xs",
												label: `Add widget to ${section.title}`,
												attributes: [
													h.OnClick(
														Message.ClickedAddSectionWidget({ sectionId: section.id, tabId: activeTabId }),
													),
												],
											},
											[icon(h, "PlusIcon")],
										),
									]
								: []),
							...(isEditable
								? [
										rowActionsMenu(h, {
											slotId: `section-menu-${section.id}`,
											model:
												model.sectionMenuId === section.id
													? model.sectionMenu
													: Menu.init(sectionMenuIdOf(section.id)),
											entries: optionEntries(h, section, inputs.index, inputs.sectionCount),
											label: `${section.title} options`,
											toParentMessage: (message) =>
												Message.GotSectionMenuMessage({ sectionId: section.id, message }),
										}),
									]
								: []),
						],
					),
				],
			),
			...(isCollapsed ? [] : [sectionBody(h, inputs)]),
		],
	)
}

const sectionBody = (h: H, inputs: SectionViewInputs): Html => {
	if (inputs.grid !== null) return h.div([h.Class("pt-2")], [inputs.grid])
	const add = Message.ClickedAddSectionWidget({ sectionId: inputs.section.id, tabId: inputs.activeTabId })
	return inputs.isEditable
		? emptyMessage(h, { className: "flex items-center gap-2 px-1 py-6 text-left" }, [
				h.span([], ["No widgets in this group yet."]),
				button(h, { variant: "ghost", size: "sm", attributes: [h.OnClick(add)] }, [
					icon(h, "PlusIcon"),
					"Add widget",
				]),
			])
		: emptyMessage(h, { className: "px-1 py-6 text-left" }, ["This group is empty."])
}

const trash = (h: H) => icon(h, "TrashIcon", { className: "text-destructive" })

/** `DeleteSectionDialog` and `DeleteTabDialog`: keep the widgets somewhere sensible, or delete them too. */
export const sectionDialogs = (h: H, model: Model): ReadonlyArray<Html> => {
	const sections = model.document?.sections ?? []
	const widgets = model.document?.widgets ?? []
	const section = sections.find((candidate) => candidate.id === model.pendingSectionDelete)
	const sectionCount = widgets.filter((widget) => widget.sectionId === section?.id).length
	const pendingTab = model.pendingTabDelete
	const tabSection = sections.find((candidate) => candidate.id === pendingTab?.sectionId)
	const tab = tabSection?.tabs.find((candidate) => candidate.id === pendingTab?.tabId)
	const destination = tabSection?.tabs.find((candidate) => candidate.id !== pendingTab?.tabId)
	const tabCount = widgets.filter(
		(widget) => widget.sectionId === pendingTab?.sectionId && widget.tabId === pendingTab?.tabId,
	).length
	return [
		confirmDialog(h, {
			slotId: "dashboard-delete-section",
			model: model.sectionDialog,
			toParentMessage: (message) => Message.GotSectionDialogMessage({ message }),
			icon: trash(h),
			title: `Delete “${section?.title ?? ""}”?`,
			description:
				sectionCount === 0
					? "This group is empty, so nothing else will be removed."
					: `This group holds ${countLabel(sectionCount, "widget")}. Keep them on the dashboard, or delete them with the group.`,
			...(sectionCount > 0
				? {
						secondaryAction: {
							label: "Keep widgets",
							onClick: Message.ConfirmedDeleteSection({ action: "ungroup" }),
						},
					}
				: undefined),
			confirmLabel: sectionCount === 0 ? "Delete group" : "Delete group & widgets",
			onConfirm: Message.ConfirmedDeleteSection({ action: "delete" }),
		}),
		confirmDialog(h, {
			slotId: "dashboard-delete-tab",
			model: model.tabDialog,
			toParentMessage: (message) => Message.GotTabDialogMessage({ message }),
			icon: trash(h),
			title: `Delete tab “${tab?.title ?? ""}”?`,
			description:
				tabCount === 0
					? "This tab is empty, so nothing else will be removed."
					: `This tab holds ${countLabel(tabCount, "widget")}.`,
			...(tabCount > 0
				? {
						secondaryAction: {
							label: `Move to “${destination?.title ?? ""}”`,
							onClick: Message.ConfirmedDeleteTab({ action: "move" }),
						},
					}
				: undefined),
			confirmLabel: tabCount === 0 ? "Delete tab" : "Delete tab & widgets",
			onConfirm: Message.ConfirmedDeleteTab({ action: "delete" }),
		}),
	]
}
