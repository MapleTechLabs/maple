import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as ChecklistView from "./onboarding-checklist-view"
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

// `DashboardLayout.Breadcrumbs` (apps/web/src/components/layout/dashboard-layout.tsx).

/** A page's trail: data, so it stays a page input (`DashboardPage`'s `breadcrumbs`). */
export type BreadcrumbEntry = Readonly<{ label: string; href?: string }>

const CRUMB_LABEL = "block max-w-[40ch] truncate"

const crumb = (h: HtmlBuilder<Message>, entry: BreadcrumbEntry): Html =>
	breadcrumbItem(h, { className: "min-w-0", title: entry.label }, [
		entry.href === undefined
			? breadcrumbPage(h, CRUMB_LABEL, [entry.label])
			: breadcrumbLink(h, { className: CRUMB_LABEL, href: entry.href }, [entry.label]),
	])

/** `IconButton variant="outline" label="Ask Maple AI" shortcut="C"` (the chat sheet is Phase 4). */
const askMapleButton = (h: HtmlBuilder<Message>): Html =>
	button(
		h,
		{
			size: "icon-sm",
			variant: "outline",
			slot: "icon-button",
			attributes: [h.AriaLabel("Ask Maple AI"), h.DataAttribute("base-ui-tooltip-trigger", "")],
		},
		[icon(h, "ChatBubbleSparkleIcon")],
	)

/** `ConnectButton`'s popover trigger (the connect panel is not ported yet). */
const connectButton = (h: HtmlBuilder<Message>): Html =>
	button(
		h,
		{
			size: "sm",
			variant: "default",
			className: "gap-2",
			slot: "popover-trigger",
			attributes: [
				h.AriaExpanded(false),
				h.AriaHasPopup("dialog"),
				h.DataAttribute("base-ui-click-trigger", ""),
				h.Tabindex(0),
			],
		},
		[icon(h, "ConnectionIcon"), "Connect"],
	)

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
					connectButton(h),
					pageActions,
				],
			),
		],
	)
