import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, buttonVariants } from "../../ui/button"
import {
	arrowRotateAnticlockwiseIcon,
	arrowUpIcon,
	chevronDownIcon,
	mediaPauseIcon,
} from "../../ui/logs/icons"
import * as LogsStreamView from "../../ui/logs/logs-stream-view"
import { eyebrowVariants } from "../../ui/logs/styles"
import { labSidebar, labTopbar } from "../shell"
import { Message, type Model, PIN_OPTIONS, type Toggle } from "./model"

// apps/web/src/lab/logs-lab.tsx `Toggle`
const toggleButton = (h: HtmlBuilder<Message>, label: string, isOn: boolean, onClick: Message): Html =>
	button(
		h,
		{
			variant: isOn ? "secondary" : "outline",
			size: "sm",
			attributes: [h.AriaPressed(isOn ? "true" : "false"), h.OnClick(onClick)],
		},
		[label],
	)

const toggles = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => {
	const flag = (label: string, isOn: boolean, which: Toggle) =>
		toggleButton(h, label, isOn, Message.ClickedToggle({ toggle: which }))
	return [
		flag("Wrap", model.wrap, "Wrap"),
		flag("Comfortable", model.density === "comfortable", "Comfortable"),
		flag("Search “pool”", Option.isSome(model.search), "Search"),
		...PIN_OPTIONS.map((key) =>
			toggleButton(h, `Pin ${key}`, model.pinned.includes(key), Message.ClickedPin({ key })),
		),
		flag("Empty", model.isEmpty, "Empty"),
	]
}

/** `formatRefreshInterval`: 0 is the off sentinel. */
const refreshLabel = (seconds: number) =>
	seconds === 0 ? "Off" : seconds < 60 ? `${seconds}s` : `${seconds / 60}m`

/** `LogsLiveControls`: why the tail holds still, then `RefreshControls`' split button. */
const liveControls = (h: HtmlBuilder<Message>, model: Model): Html => {
	const isOn = model.refreshInterval > 0
	const isPaused = isOn && model.isInspecting
	return h.div(
		[h.Class("flex items-center gap-2")],
		[
			h.output(
				[h.Class("flex items-center gap-2")],
				[
					...(isPaused
						? [
								h.span(
									[h.Class("flex items-center gap-1.5 text-muted-foreground text-xs")],
									[mediaPauseIcon(h, 10), "Paused while you inspect"],
								),
							]
						: []),
					...(isPaused && model.isScrolledAway
						? [
								button(
									h,
									{
										variant: "ghost",
										size: "xs",
										attributes: [h.OnClick(Message.ClickedJumpToLatest())],
									},
									[arrowUpIcon(h, 24), "Jump to latest"],
								),
							]
						: []),
				],
			),
			h.div(
				[h.Class("flex items-center")],
				[
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							className: "relative rounded-r-none before:rounded-r-none focus-visible:z-10",
							isDisabled: model.isReloading,
							attributes: [
								...(model.isReloading ? [h.AriaBusy(true)] : []),
								h.OnClick(Message.ClickedReload()),
							],
						},
						[
							arrowRotateAnticlockwiseIcon(
								h,
								24,
								cn("size-3.5", model.isReloading && "animate-spin"),
							),
							h.span([], ["Reload"]),
						],
					),
					// The interval menu (Base UI DropdownMenu) is not ported; the trigger renders closed.
					h.button(
						[
							h.Type("button"),
							h.Class(
								cn(
									buttonVariants({
										className:
											"relative -ml-px rounded-l-none before:rounded-l-none focus-visible:z-10",
										size: "sm",
										variant: "outline",
									}),
								),
							),
							h.DataAttribute("slot", "dropdown-menu-trigger"),
							h.Title(
								isOn
									? `Reloading every ${refreshLabel(model.refreshInterval)}`
									: "Auto-refresh is off",
							),
							h.AriaLabel(
								isOn
									? `Auto-refresh every ${refreshLabel(model.refreshInterval)}`
									: "Auto-refresh off",
							),
							h.AriaExpanded(false),
							h.AriaHasPopup("menu"),
							h.Tabindex(0),
						],
						[
							h.span(
								[h.Class(cn("tabular-nums", !isOn && "text-muted-foreground"))],
								[refreshLabel(model.refreshInterval)],
							),
							chevronDownIcon(h, 24, "size-3 opacity-60"),
						],
					),
				],
			),
		],
	)
}

const pageHeader = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.div(
		[
			h.Class(
				"flex flex-col gap-2 @2xl/page:flex-row @2xl/page:items-start @2xl/page:justify-between @2xl/page:gap-4",
			),
			h.DataAttribute("slot", "page-header"),
		],
		[
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center gap-1.5")],
						[
							h.span(
								[
									h.Class(cn(eyebrowVariants({ variant: undefined }), "mr-1")),
									h.DataAttribute("slot", "eyebrow"),
								],
								["Lab"],
							),
							...toggles(h, model),
						],
					),
				],
			),
			h.div(
				[h.Class("min-w-0 @2xl/page:shrink-0"), h.DataAttribute("slot", "page-header-actions")],
				[liveControls(h, model)],
			),
		],
	)

const pageBody = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.div(
		[h.Class("flex min-h-0 flex-1 overflow-hidden"), h.DataAttribute("slot", "page-body")],
		[
			h.main(
				[
					h.Class("@container/page flex min-h-0 min-w-0 flex-1 flex-col"),
					h.DataAttribute("slot", "page-content"),
					h.Id("main-content"),
				],
				[
					h.div(
						[
							h.Class(
								cn(
									"shrink-0 space-y-4 p-4 transition-shadow",
									model.isScrolledAway && "shadow-[0_2px_8px_rgba(0,0,0,0.08)]",
								),
							),
							h.DataAttribute("slot", "page-sticky-area"),
						],
						[pageHeader(h, model)],
					),
					h.div(
						[
							h.Class("flex min-h-0 min-w-0 flex-1 flex-col"),
							h.DataAttribute("slot", "page-fill"),
						],
						// The empty state (`SignalEmptyState`) and the filter chip strip are not ported yet.
						model.stream.rows.length === 0
							? []
							: [
									h.submodel({
										slotId: "logs-stream",
										model: model.stream,
										view: LogsStreamView.view,
										toParentMessage: (message) => Message.GotStreamMessage({ message }),
										viewInputs: {
											wrap: model.wrap,
											density: model.density,
											pinnedColumns: model.pinned,
											searchText: Option.getOrUndefined(model.search),
											timeZone: model.timeZone,
											isWaiting: false,
											footerText: model.footerText,
											canFilter: true,
										},
									}),
								],
					),
				],
			),
		],
	)

/** apps/web's `DashboardLayout` around the lab page, with the generated shell (see ../shell.ts). */
export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.Class("group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar"),
			h.DataAttribute("slot", "sidebar-wrapper"),
			h.Style({ "--sidebar-width": "16rem", "--sidebar-width-icon": "3rem" }),
		],
		[
			labSidebar(h),
			h.main(
				[
					h.Class(
						"relative flex h-svh w-full min-h-0 min-w-0 flex-1 flex-col bg-background md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2 md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm/5",
					),
					h.DataAttribute("slot", "sidebar-inset"),
				],
				[
					h.a(
						[
							h.Class(
								"sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-4 focus:bg-background focus:text-foreground",
							),
							h.Href("#main-content"),
						],
						["Skip to main content"],
					),
					h.div(
						[h.Class("flex min-h-0 flex-1 flex-col"), h.DataAttribute("slot", "page-layout")],
						[labTopbar(h), pageBody(h, model)],
					),
				],
			),
		],
	)
