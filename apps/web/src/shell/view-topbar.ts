import { cn } from "@maple/ui/lib/utils"
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
import { separator } from "../ui/display"
import { sidebarTrigger } from "../ui/sidebar"
import { Message } from "./message"
import type { Model } from "./model"
import { type SourceLink, sourceLinkButton } from "./source-link"

// The top bar's breadcrumbs.

/** A page's trail: data, so it stays a page input (`DashboardPage`'s `breadcrumbs`). */
export type BreadcrumbEntry = Readonly<{
	label: string
	href?: string
	/** The page draws this label as its own `<h1>`: a lone crumb like this is for screen readers only. */
	isPageHeading?: boolean
}>

const CRUMB_LABEL = "block max-w-[40ch] truncate"

const crumb = (h: HtmlBuilder<Message>, entry: BreadcrumbEntry, className?: string): Html =>
	breadcrumbItem(h, { className: cn("min-w-0", className), title: entry.label }, [
		entry.href === undefined
			? breadcrumbPage(h, CRUMB_LABEL, [entry.label])
			: breadcrumbLink(h, { className: CRUMB_LABEL, href: entry.href }, [entry.label]),
	])

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

/** The Sources list and /sources/new draw their own "Connect source", so the top bar's would repeat it. */
export const hidesTopbarConnect = (currentPath: string): boolean => /^\/sources(\/new)?\/?$/.test(currentPath)

/** A lone crumb that repeats the page's `<h1>`, so it is kept for screen readers only. */
const isTitleOnly = (breadcrumbs: ReadonlyArray<BreadcrumbEntry>): boolean =>
	breadcrumbs.length === 1 && breadcrumbs[0]?.isPageHeading === true

export const topbar = (
	h: HtmlBuilder<Message>,
	model: Model,
	breadcrumbs: ReadonlyArray<BreadcrumbEntry>,
	pageActions: Html,
	/** `FilterSidebarTrigger` / `RightSidebarTrigger`: below `lg`, one per rail the page renders. */
	railTriggers: ReadonlyArray<Html> = [],
	showsConnect = true,
	/** Where the page's data comes from (`source-link.ts`). */
	sourceLink: SourceLink | null = null,
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
					// Phones keep only the page's own crumb; its heading below names the rest.
					breadcrumbs.flatMap((entry, index) => {
						const isEarlier = index < breadcrumbs.length - 1
						return [
							...(index > 0 ? [breadcrumbSeparator(h, "shrink-0 max-sm:hidden")] : []),
							crumb(h, entry, isEarlier ? "max-sm:hidden" : undefined),
						]
					}),
				),
			]),
			h.div(
				[h.Class("ml-auto flex shrink-0 items-center gap-2")],
				[
					...(isClerkAuthEnabled ? [checklistPill(h, model)] : []),
					...(showsConnect ? [connectButton(h, model)] : []),
					...railTriggers,
					...(sourceLink === null ? [] : [sourceLinkButton(h, sourceLink)]),
					pageActions,
				],
			),
		],
	)
