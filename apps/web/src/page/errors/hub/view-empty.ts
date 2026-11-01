import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon, type IconName } from "../../../ui/icon"
import { docsLink, filteredEmpty, presenceLoading, signalEmptyState } from "../../kit/signal-empty-state"
import { presenceOf } from "../../kit/signal-presence"
import { SEVERITY_LABEL } from "../kit/severity"
import { hasErrorFilters, severityOf, viewOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The hub's empty state: what an empty view says, and what it offers.

type H = HtmlBuilder<Message>

const VIEW_LABEL = { open: "Open", closed: "Closed", all: "All" } as const

const EMPTY_COPY = {
	open: {
		icon: "CircleCheckIcon",
		title: "Nothing open",
		description: "Every issue here is closed out. Check Closed to see recent fixes.",
	},
	all: {
		icon: "CircleCheckIcon",
		title: "No errors recorded",
		description: "Your services are sending traces and none have failed.",
	},
	closed: {
		icon: "HistoryIcon",
		title: "Nothing closed yet",
		description: "Issues you close land here, so you can check whether a fix held.",
	},
} satisfies Record<keyof typeof VIEW_LABEL, { icon: IconName; title: string; description: string }>

const ERRORS_PURPOSE = "Group failed spans and exceptions into issues you can triage, assign and resolve."

const SEVERITY_FILTER_LABEL = { all: "All severities", ...SEVERITY_LABEL, unset: "Unset" } as const

const iconMedia = (h: H, name: IconName): Html =>
	emptyMedia(h, { variant: "icon" }, [icon(h, name)])

const actions = (h: H, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex flex-wrap items-center justify-center gap-2")], children)

/** A search with no matches: offer every tab, and the way out of the search. */
const searchEmpty = (h: H, search: string, view: keyof typeof VIEW_LABEL): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				iconMedia(h, "MagnifierIcon"),
				emptyTitle(h, ["No issues match “", search, "”"]),
				emptyDescription(h, [
					view === "all"
						? "Search covers the type, message and service of every issue."
						: `Nothing in ${VIEW_LABEL[view]} matches. It may be in another tab.`,
				]),
			]),
			actions(h, [
				...(view !== "all"
					? [
							button(
								h,
								{
									size: "sm",
									variant: "outline",
									attributes: [h.OnClick(Message.ClickedViewAll())],
								},
								["Search all issues"],
							),
						]
					: []),
				button(
					h,
					{ size: "sm", variant: "ghost", attributes: [h.OnClick(Message.ClickedClearSearch())] },
					["Clear search"],
				),
			]),
		],
		"py-12",
	)

/** Narrowed views say so; an un-narrowed one is an all-clear only once traces have arrived. */
export const hubEmpty = (h: H, model: Model, isNarrowedBySidebar: boolean): Html => {
	const view = viewOf(model.search)
	const severity = severityOf(model.search)
	const search = model.search.q ?? ""
	if (search !== "") return searchEmpty(h, search, view)
	const isFiltered = severity !== "all"
	const isNarrowed = isFiltered || isNarrowedBySidebar
	const presence = presenceOf(model.presence, "traces")
	if (!isNarrowed && presence.status === "loading") return presenceLoading(h, "py-12")
	if (!isNarrowed && presence.status === "absent") {
		return signalEmptyState(h, {
			signal: "traces",
			presence,
			nowMs: model.nowMs,
			noun: "errors",
			purpose: ERRORS_PURPOSE,
			guideDocs: "errors",
			className: "py-12",
		})
	}
	if (isNarrowedBySidebar && !isFiltered)
		return filteredEmpty(h, {
			noun: view === "all" ? "errors" : `${VIEW_LABEL[view].toLowerCase()} errors`,
			description: "Everything in this view was excluded by the sidebar filters.",
			onClear: Message.ClickedClearFilters(),
			className: "py-12",
		})
	const copy = EMPTY_COPY[view]
	const isUnknown = !isNarrowed && presence.status === "unknown"
	const iconName: IconName = isNarrowed ? "MagnifierIcon" : isUnknown ? "HistoryIcon" : copy.icon
	const title = !isUnknown
		? copy.title
		: view === "all"
			? "No errors found"
			: `No ${VIEW_LABEL[view].toLowerCase()} errors`
	const description = isUnknown ? ERRORS_PURPOSE : copy.description
	return empty(
		h,
		[
			emptyHeader(h, [
				iconMedia(h, iconName),
				emptyTitle(h, [
					isFiltered ? `No ${SEVERITY_FILTER_LABEL[severity].toLowerCase()} errors here` : title,
				]),
				emptyDescription(h, [
					isFiltered
						? `Nothing in ${VIEW_LABEL[view]} matches that severity. Other severities may have plenty.`
						: description,
				]),
			]),
			...(view === "all" && !isNarrowed ? [docsLink(h, "errors")] : []),
			...(isFiltered || isNarrowedBySidebar || view !== "all"
				? [
						actions(h, [
							...(isFiltered
								? [
										outline(
											h,
											"outline",
											Message.ClickedShowAllSeverities(),
											"Show all severities",
										),
									]
								: []),
							...(isNarrowedBySidebar
								? [
										outline(
											h,
											isFiltered ? "ghost" : "outline",
											Message.ClickedClearFilters(),
											"Clear filters",
										),
									]
								: []),
							...(view !== "all"
								? [
										outline(
											h,
											isFiltered || isNarrowedBySidebar ? "ghost" : "outline",
											Message.ClickedViewAll(),
											"See every error",
										),
									]
								: []),
						]),
					]
				: []),
		],
		"py-12",
	)
}

const outline = (h: H, variant: "outline" | "ghost", onClick: Message, label: string): Html =>
	button(h, { size: "sm", variant, attributes: [h.OnClick(onClick)] }, [label])

/** The sidebar's own filters: the empty state offers to clear them. */
export const isNarrowedBySidebar = (model: Model): boolean => hasErrorFilters(model.search)
