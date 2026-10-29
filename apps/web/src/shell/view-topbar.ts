import { isClerkAuthEnabled } from "../lib/services/common/auth-mode"
import type { Html } from "foldkit/html"
import { ChecklistBinding, ConnectBinding, type ShellViewBuilder } from "./composition"
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

type H = ShellViewBuilder

// The top bar's breadcrumbs.

/** A page's trail: data, so it stays a page input (`DashboardPage`'s `breadcrumbs`). */
export type BreadcrumbEntry = Readonly<{
	label: string
	href?: string
	/** The page draws this label as its own `<h1>`: a lone crumb like this is for screen readers only. */
	isPageHeading?: boolean
}>

const CRUMB_LABEL = "block max-w-[40ch] truncate"

const crumb = (h: H, entry: BreadcrumbEntry): Html =>
	breadcrumbItem(h, { className: "min-w-0", title: entry.label }, [
		entry.href === undefined
			? breadcrumbPage(h, CRUMB_LABEL, [entry.label])
			: breadcrumbLink(h, { className: CRUMB_LABEL, href: entry.href }, [entry.label]),
	])

/** `IconButton variant="outline" label="Ask Maple AI" shortcut="C"`: opens the global chat sheet. */
const askMapleButton = (h: H): Html =>
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
const connectButton = (h: H, model: Model): Html =>
	h.block(ConnectBinding.embedView({ slotId: "connect-panel", model: model.connect }))

/** `OnboardingChecklistButton`: Clerk only, self-hosted has no billing to credit. */
const checklistPill = (h: H, model: Model): Html =>
	h.block(ChecklistBinding.embedView({ slotId: "onboarding-checklist", model: model.checklist }))

/** The Sources list and /sources/new draw their own "Connect source", so the top bar's would repeat it. */
export const hidesTopbarConnect = (currentPath: string): boolean => /^\/sources(\/new)?\/?$/.test(currentPath)

/** A lone crumb that repeats the page's `<h1>`, so it is kept for screen readers only. */
const isTitleOnly = (breadcrumbs: ReadonlyArray<BreadcrumbEntry>): boolean =>
	breadcrumbs.length === 1 && breadcrumbs[0]?.isPageHeading === true

export const topbar = (
	h: H,
	model: Model,
	breadcrumbs: ReadonlyArray<BreadcrumbEntry>,
	pageActions: Html,
	/** `FilterSidebarTrigger` / `RightSidebarTrigger`: below `lg`, one per rail the page renders. */
	railTriggers: ReadonlyArray<Html> = [],
	showsConnect = true,
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
			...(isTitleOnly(breadcrumbs) ? [] : [separator(h, "vertical", "mr-2 h-4")]),
			breadcrumb(h, "min-w-0 flex-1", [
				breadcrumbList(
					h,
					isTitleOnly(breadcrumbs) ? "sr-only" : "flex-nowrap",
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
					...(showsConnect ? [connectButton(h, model)] : []),
					...railTriggers,
					pageActions,
				],
			),
		],
	)
