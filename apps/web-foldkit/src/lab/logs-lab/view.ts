import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import * as LogsStreamView from "../../ui/logs/logs-stream-view"
import { eyebrow } from "../../ui/eyebrow"
import * as ToastView from "../../ui/toast-view"
import { liveControls } from "../../page/logs/live-controls"
import { labShellView } from "../app-shell"
import { Message, type Model, PIN_OPTIONS, type Toggle } from "./model"

// `Toggle`
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
						[eyebrow(h, { className: "mr-1" }, ["Lab"]), ...toggles(h, model)],
					),
				],
			),
			h.div(
				[h.Class("min-w-0 @2xl/page:shrink-0"), h.DataAttribute("slot", "page-header-actions")],
				[
					liveControls(h, {
						...model,
						onReload: Message.ClickedReload(),
						onJumpToLatest: Message.ClickedJumpToLatest(),
						menu: model.refreshMenu,
						toMenuMessage: (message) => Message.GotRefreshMenuMessage({ message }),
					}),
				],
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

/** The real shell around the lab page, then the toast regions. */
export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Id("app")],
		[
			...labShellView(h, model.shell, (message) => Message.GotShellMessage({ message }), {
				currentPath: "/lab/logs",
				breadcrumbs: [{ label: "Lab" }, { label: "Logs" }],
				page: () => pageBody(h, model),
			}),
			...ToastView.regions(h, model.toasts, (message) => Message.GotToastMessage({ message })),
		],
	)
