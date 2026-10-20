import { isClerkAuthEnabled } from "../lib/services/common/auth-mode"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as ChecklistView from "./onboarding-checklist-view"
import * as ConnectPanelView from "./connect-panel-view"
import {
	breadcrumb,
	breadcrumbItem,
	breadcrumbLink,
	breadcrumbList,
	breadcrumbPage,
	breadcrumbSeparator,
} from "../ui/breadcrumb"
import { button } from "../ui/button"
import { separator } from "../ui/display"
import { icon } from "../ui/icon"
import { sidebarTrigger } from "../ui/sidebar"
import { Message } from "./message"
import type { Model } from "./model"

// The top bar's breadcrumbs.

/** A page's trail: data, so it stays a page input (`DashboardPage`'s `breadcrumbs`). */
export type BreadcrumbEntry = Readonly<{ label: string; href?: string }>

const CRUMB_LABEL = "block max-w-[40ch] truncate"

const crumb = (h: HtmlBuilder<Message>, entry: BreadcrumbEntry): Html =>
	breadcrumbItem(h, { className: "min-w-0", title: entry.label }, [
		entry.href === undefined
			? breadcrumbPage(h, CRUMB_LABEL, [entry.label])
			: breadcrumbLink(h, { className: CRUMB_LABEL, href: entry.href }, [entry.label]),
	])

/** `IconButton variant="outline" label="Ask Maple AI" shortcut="C"`: opens the global chat sheet. */
const askMapleButton = (h: HtmlBuilder<Message>): Html =>
	button(
		h,
		{
			size: "icon-sm",
			variant: "outline",
			slot: "icon-button",
			attributes: [
				h.AriaLabel("Ask Maple AI"),
				h.DataAttribute("base-ui-tooltip-trigger", ""),
				h.OnClick(Message.ClickedAskMapleAi()),
			],
		},
		[icon(h, "ChatBubbleSparkleIcon")],
	)

/** `ConnectButton`: the ingest endpoint, keys and MCP popover. */
const connectButton = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.submodel({
		slotId: "connect-panel",
		model: model.connect,
		view: ConnectPanelView.view,
		toParentMessage: (message) => Message.GotConnectMessage({ message }),
	})

/** `OnboardingChecklistButton`: Clerk only, self-hosted has no billing to credit. */
const checklistPill = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.submodel({
		slotId: "onboarding-checklist",
		model: model.checklist,
		view: ChecklistView.view,
		toParentMessage: (message) => Message.GotChecklistMessage({ message }),
	})

export const topbar = (
	h: HtmlBuilder<Message>,
	model: Model,
	breadcrumbs: ReadonlyArray<BreadcrumbEntry>,
	pageActions: Html,
	/** `FilterSidebarTrigger` / `RightSidebarTrigger`: below `lg`, one per rail the page renders. */
	railTriggers: ReadonlyArray<Html> = [],
): Html =>
	h.header(
		[
			h.Class("flex h-16 shrink-0 items-center gap-2 border-b px-4"),
			h.DataAttribute("slot", "app-topbar"),
		],
		[
			sidebarTrigger(h, {
				state: model.isSidebarOpen ? "expanded" : "collapsed",
				className: "-ml-1",
				attributes: [h.OnClick(Message.ClickedSidebarTrigger())],
			}),
			separator(h, "vertical", "mr-2 h-4"),
			breadcrumb(h, "min-w-0 flex-1", [
				breadcrumbList(
					h,
					"flex-nowrap",
					breadcrumbs.flatMap((entry, index) => [
						...(index > 0 ? [breadcrumbSeparator(h, "shrink-0")] : []),
						crumb(h, entry),
					]),
				),
			]),
			h.div(
				[h.Class("ml-auto flex shrink-0 items-center gap-2")],
				[
					askMapleButton(h),
					...(isClerkAuthEnabled ? [checklistPill(h, model)] : []),
					connectButton(h, model),
					...railTriggers,
					pageActions,
				],
			),
		],
	)
