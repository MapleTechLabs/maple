import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { emptyMessage } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import * as Menu from "../../../ui/menu"
import * as MenuView from "../../../ui/menu-view"
import { truncatedText } from "../../../ui/truncated-text"
import { isLoading } from "../conversation/model"
import { dotLoader } from "../kit/dot-loader"
import { MountRenameInput, MountStopClickPropagation } from "./mounts"
import { Message } from "./message"
import type { ChatTab, Model } from "./model"

// The chat sidebar: conversations grouped by recency.

const DAY_MS = 24 * 60 * 60 * 1000

/** Local midnight of the day `ts` falls on (`setHours(0, 0, 0, 0)`). */
const startOfDay = (ts: number): number => {
	const date = new Date(ts)
	date.setHours(0, 0, 0, 0)
	return date.getTime()
}

export const groupTabs = (
	tabs: ReadonlyArray<ChatTab>,
	nowMs: number,
): ReadonlyArray<{ readonly label: string; readonly tabs: ReadonlyArray<ChatTab> }> => {
	const today = startOfDay(nowMs)
	const yesterday = today - DAY_MS
	const week = today - 7 * DAY_MS
	const byRecency = (a: ChatTab, b: ChatTab) => b.updatedAt - a.updatedAt
	const within = (from: number, to: number) =>
		tabs.filter((tab) => tab.updatedAt >= from && tab.updatedAt < to).toSorted(byRecency)
	return [
		{ label: "Today", tabs: within(today, Number.POSITIVE_INFINITY) },
		{ label: "Yesterday", tabs: within(yesterday, today) },
		{ label: "Previous 7 days", tabs: within(week, yesterday) },
		{ label: "Older", tabs: within(Number.NEGATIVE_INFINITY, week) },
	].filter((group) => group.tabs.length > 0)
}

const tabIcon = (tab: ChatTab) =>
	tab.id.startsWith("alert-")
		? Option.some("BellIcon" as const)
		: tab.id.startsWith("widget-fix-")
			? Option.some("ChartLineIcon" as const)
			: Option.none()

const menuEntries = (canDelete: boolean): ReadonlyArray<MenuView.MenuEntry> => [
	{ _tag: "Item", value: "rename", label: "Rename", icon: "PencilIcon" },
	{ _tag: "Item", value: "copy-link", label: "Copy link", icon: "LinkIcon" },
	{
		_tag: "Item",
		value: "delete",
		label: "Delete",
		icon: "TrashIcon",
		variant: "destructive",
		isDisabled: !canDelete,
	},
]

const rowActions = (
	h: HtmlBuilder<Message>,
	model: Model,
	tab: ChatTab,
	isActive: boolean,
	canDelete: boolean,
): Html =>
	h.submodel({
		slotId: `chat-tab-menu-${tab.id}`,
		model: model.menus[tab.id] ?? Menu.init(`chat-tab-menu-${tab.id}`),
		view: MenuView.view,
		viewInputs: {
			entries: menuEntries(canDelete),
			side: "right",
			align: "start",
			sideOffset: 4,
			className: "min-w-36",
			toView: ({ trigger, withTrigger }) =>
				h.span(
					[h.Class("contents")],
					withTrigger(
						h.button(
							[
								h.AriaLabel(`Actions for ${tab.title}`),
								h.Class(
									cn(
										"shrink-0 rounded-sm p-1 transition-opacity hover:bg-foreground/10 max-md:p-1.5",
										isActive
											? "opacity-60 hover:opacity-100"
											: "opacity-0 group-hover:opacity-60 hover:!opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 max-md:opacity-60",
									),
								),
								h.Tabindex(0),
								h.Type("button"),
								h.OnMount(MountStopClickPropagation()),
								...trigger,
							],
							[icon(h, "DotsIcon", { size: 14 })],
						),
					),
				),
		},
		toParentMessage: (message) => Message.GotTabMenuMessage({ tabId: tab.id, message }),
	})

const renameInput = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.input([
		h.Value(model.renameDraft),
		h.OnInput((text) => Message.ChangedRenameDraft({ text })),
		h.OnBlur(Message.CommittedRename()),
		h.OnKeyDownPreventDefault((key) =>
			key === "Enter"
				? Option.some(Message.CommittedRename())
				: key === "Escape"
					? Option.some(Message.CancelledRename())
					: Option.none(),
		),
		h.OnMount(MountRenameInput()),
		h.Class(
			"min-w-0 flex-1 bg-transparent text-sm outline-none ring-1 ring-ring/50 rounded-sm px-1 -mx-1",
		),
	])

const tabRow = (
	h: HtmlBuilder<Message>,
	model: Model,
	tab: ChatTab,
	isActive: boolean,
	canDelete: boolean,
): Html => {
	const isRenaming = model.renamingId === tab.id
	const conversation = model.conversations[tab.id]
	const loading = conversation !== undefined && isLoading(conversation)
	const leading = loading
		? [dotLoader(h, { label: "Working", color: "var(--primary)" })]
		: Option.match(tabIcon(tab), {
				onNone: () => [],
				onSome: (name) => [
					icon(h, name, { size: 14, className: "shrink-0 text-muted-foreground/70" }),
				],
			})
	return h.li(
		[],
		[
			h.div(
				[
					...(isRenaming
						? []
						: [
								h.Role("button"),
								h.Tabindex(0),
								h.OnDoubleClick(Message.DoubleClickedTab({ id: tab.id })),
								h.OnKeyDownPreventDefault((key) =>
									key === "Enter" || key === " "
										? Option.some(Message.ClickedTab({ id: tab.id }))
										: Option.none(),
								),
							]),
					h.OnClick(Message.ClickedTab({ id: tab.id })),
					h.Class(
						cn(
							"group relative flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors max-md:h-10",
							!isRenaming && "cursor-pointer",
							isActive
								? "bg-sidebar-accent text-sidebar-accent-foreground"
								: "text-sidebar-foreground/85 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
						),
					),
				],
				[
					...leading,
					isRenaming
						? renameInput(h, model)
						: truncatedText(h, { text: tab.title, className: "flex-1 text-left" }, [tab.title]),
					...(isRenaming ? [] : [rowActions(h, model, tab, isActive, canDelete)]),
				],
			),
		],
	)
}

export const chatSidebar = (h: HtmlBuilder<Message>, model: Model, className: string): Html => {
	const tabs = model.tabs?.tabs ?? []
	const groups = groupTabs(tabs, model.nowMs)
	const canDelete = tabs.length > 1
	const pendingTitle = Option.match(
		Option.flatMap(Option.fromNullishOr(model.confirmDeleteId), (id) =>
			Option.fromNullishOr(tabs.find((tab) => tab.id === id)),
		),
		{ onNone: () => "", onSome: (tab) => tab.title },
	)
	return h.aside(
		[
			h.Class(
				cn(
					"flex h-full shrink-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground",
					className,
				),
			),
			h.AriaLabel("Chat conversations"),
		],
		[
			h.div(
				[h.Class("flex w-full flex-1 flex-col")],
				[
					h.div(
						[h.Class("p-3")],
						[
							button(
								h,
								{
									size: "sm",
									className: "w-full justify-start gap-2 font-medium",
									attributes: [h.OnClick(Message.ClickedNewChat())],
								},
								[icon(h, "PlusIcon"), "New chat"],
							),
						],
					),
					h.div(
						[h.Class("min-h-0 flex-1 overflow-y-auto px-2 pb-3")],
						groups.length === 0
							? [
									emptyMessage(h, { className: "px-2 py-6 text-sidebar-foreground/60" }, [
										"No conversations yet",
									]),
								]
							: groups.map((group) =>
									h.div(
										[h.Class("mb-3")],
										[
											eyebrow(
												h,
												{
													as: "div",
													className: "px-2 py-1 text-sidebar-foreground/60",
												},
												[group.label],
											),
											h.ul(
												[h.Class("flex flex-col gap-0.5")],
												group.tabs.map((tab) =>
													tabRow(
														h,
														model,
														tab,
														tab.id === model.tabs?.activeTabId,
														canDelete,
													),
												),
											),
										],
									),
								),
					),
				],
			),
			confirmDialog(h, {
				slotId: "chat-delete-dialog",
				model: model.deleteDialog,
				toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
				title: "Delete this conversation?",
				description: `"${pendingTitle}" and its messages will be removed. This cannot be undone.`,
				confirmLabel: "Delete",
				onConfirm: Message.ClickedConfirmDelete(),
			}),
		],
	)
}
