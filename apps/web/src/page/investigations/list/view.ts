import type { V2Investigation } from "@maple/domain/http/v2"
import { EMPTY_VALUE, formatNumber, pluralize } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import {
	investigationFinding,
	investigationHeadline,
	investigationScope,
	investigationSeverity,
} from "@maple/web-data/investigations/display"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { alert, alertAction, alertDescription, alertTitle } from "../../../ui/alert"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { pageTitle } from "../../../ui/page-layout"
import { icon } from "../../../ui/icon"
import { listRow } from "../../../ui/list-row"
import { panel } from "../../../ui/panel"
import { searchInput } from "../../../ui/search-input"
import * as SelectView from "../../../ui/select-view"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import * as TabsView from "../../../ui/tabs-view"
import { truncatedText } from "../../../ui/truncated-text"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { listToolbar, toolbarCount, toolbarStat } from "../../kit/list-toolbar"
import { relativeTime } from "../../kit/relative-time"
import { docsLink, filteredEmpty } from "../../kit/signal-empty-state"
import { presenceOf } from "../../kit/signal-presence"
import { severityBadge } from "../../errors/kit/severity"
import { confidenceMeter, investigateBar, kindMarker, statusBadge } from "../kit"
import { ROW_ATTRIBUTE } from "../clicks"
import { MountInvestigationRows } from "./command"
import {
	allOf,
	type HubView,
	isActive,
	isLoadingMoreOf,
	KIND_FILTER_LABEL,
	KIND_FILTER_VALUES,
	nextCursorOf,
	SORT_OPTIONS,
	triageStatsOf,
	viewOf,
	visibleOf,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// `InvestigationsHub` and `InvestigationTable`: the investigations list page.

type H = HtmlBuilder<Message>

const bar = (h: H, model: Model, isAccent = false, placeholder?: string): Html =>
	investigateBar(h, {
		value: model.subject,
		onInput: (value) => Message.ChangedSubject({ value }),
		onSubmit: Message.SubmittedSubject(),
		isBusy: model.isCreating,
		isAccent,
		placeholder,
	})

const KIND_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = KIND_FILTER_VALUES.map((value) => ({
	_tag: "Item",
	item: { value, label: KIND_FILTER_LABEL[value] },
}))
const SORT_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = SORT_OPTIONS.map((option) => ({
	_tag: "Item",
	item: { value: option.value, label: option.label },
}))

const kindLabel = (value: string): string =>
	KIND_FILTER_LABEL[KIND_FILTER_VALUES.find((kind) => kind === value) ?? "all"]
const sortLabel = (value: string): string =>
	SORT_OPTIONS.find((option) => option.value === value)?.label ?? SORT_OPTIONS[0].label

const toolbar = (
	h: H,
	model: Model,
	all: ReadonlyArray<V2Investigation>,
	visible: ReadonlyArray<V2Investigation>,
	hasMore: boolean,
	isKnown: boolean,
	isFramed: boolean,
): Html => {
	const activeCount = all.filter(isActive).length
	const counts = new Map([
		["active", activeCount],
		["history", all.length - activeCount],
	])
	const stats = triageStatsOf(all, model.nowMs)
	return listToolbar(h, {
		framed: isFramed,
		leading: h.submodel({
			slotId: "investigations-view-tabs",
			model: model.tabs,
			view: TabsView.view,
			viewInputs: {
				labels: ["Active", "History"],
				ariaLabel: "Filter investigations",
				tabClassName: "group/tab h-7 grow-0 px-2.5 text-xs sm:h-7 sm:text-xs",
				// Unknown counts (loading or failed) are left out, never a false 0.
				tabContent: (value, label) => [
					label,
					...(isKnown
						? [
								h.span(
									[
										h.Class(
											"text-foreground-subtle tabular-nums group-data-active/tab:text-muted-foreground",
										),
									],
									[String(counts.get(value) ?? 0)],
								),
							]
						: []),
				],
				panel: () => undefined,
			},
			toParentMessage: (message) => Message.GotTabsMessage({ message }),
		}),
		trailing: [
			...(isKnown
				? [
						h.div(
							[h.Class("hidden items-center gap-3 sm:flex")],
							[
								toolbarStat(h, {
									value: formatNumber(stats.running),
									label: "investigating",
									dot: stats.running > 0 ? "info" : undefined,
								}),
								toolbarStat(h, {
									value: formatNumber(stats.review),
									label:
										stats.critical > 0
											? `to review (${stats.critical} critical)`
											: "to review",
									dot: stats.review > 0 ? "warn" : undefined,
								}),
								toolbarStat(h, {
									value: formatNumber(stats.resolved),
									label: "resolved in 24h",
								}),
							],
						),
					]
				: []),
			h.submodel({
				slotId: model.kindSelect.id,
				model: model.kindSelect,
				view: SelectView.view,
				viewInputs: {
					entries: KIND_ENTRIES,
					className: "w-36",
					renderValue: (value) => [kindLabel(value)],
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
				toParentMessage: (message) => Message.GotKindSelectMessage({ message }),
			}),
			h.submodel({
				slotId: model.sortSelect.id,
				model: model.sortSelect,
				view: SelectView.view,
				viewInputs: {
					entries: SORT_ENTRIES,
					className: "w-44",
					renderValue: (value) => [sortLabel(value)],
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
				toParentMessage: (message) => Message.GotSortSelectMessage({ message }),
			}),
			searchInput(h, {
				id: "investigations-search",
				size: "sm",
				className: "w-auto min-w-56 max-w-sm flex-1",
				placeholder: "Search subjects and findings",
				value: model.searchDraft,
				onInput: (value) => Message.ChangedSearchDraft({ value }),
				onClear: Message.ChangedSearchDraft({ value: "" }),
			}),
			toolbarCount(
				h,
				!isKnown
					? []
					: hasMore
						? [`Showing ${visible.length} of the ${all.length} most recent`]
						: [String(visible.length), " ", pluralize(visible.length, "investigation")],
			),
		],
	})
}

const rowFinding = (h: H, investigation: V2Investigation): Html => {
	const finding = investigationFinding(investigation)
	if (finding.kind === "pending")
		return h.span(
			[h.Class("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground")],
			[statusDot(h, { tone: "live" }), truncatedText(h, { text: finding.text })],
		)
	if (finding.kind === "none") return h.span([h.Class("text-xs text-foreground-subtle")], [EMPTY_VALUE])
	return h.span(
		[
			h.Class(
				cn(
					"flex min-w-0 items-center gap-1.5 text-xs",
					finding.kind === "failure" && "text-severity-error",
					finding.kind === "partial" && "text-severity-warn",
					finding.kind !== "failure" && finding.kind !== "partial" && "text-muted-foreground",
				),
			),
		],
		[truncatedText(h, { text: finding.text })],
	)
}

const row = (h: H, investigation: V2Investigation, nowMs: number, timeZone: string): Html => {
	const headline = investigationHeadline(investigation)
	const scope = investigationScope(investigation)
	return listRow(
		h,
		{
			as: "li",
			divided: true,
			className: "cursor-pointer gap-3.5 py-3.5",
			leading: h.span(
				[h.Class("flex w-5 items-center justify-center")],
				[kindMarker(h, investigation.subject, investigation.seeded_by)],
			),
			title: h.span(
				[h.Class("flex min-w-0 items-baseline gap-2")],
				[
					h.a(
						[
							h.Href(hrefOf(AppRoute.Investigation({ id: investigation.id, search: {} }))),
							h.Class("min-w-0 truncate font-medium text-sm text-foreground hover:underline"),
							h.Title(headline),
						],
						[headline],
					),
					...(scope
						? [
								truncatedText(h, {
									text: scope,
									className: "max-w-[40%] shrink font-normal text-xs text-muted-foreground",
								}),
							]
						: []),
				],
			),
			meta: rowFinding(h, investigation),
			trailing: h.span(
				[h.Class("flex items-center gap-3.5")],
				[
					h.span(
						[h.Class("w-20 shrink-0 max-md:hidden")],
						[confidenceMeter(h, investigation.confidence)],
					),
					h.span(
						[h.Class("w-18 shrink-0 max-sm:hidden")],
						[severityBadge(h, investigationSeverity(investigation))],
					),
					h.span([h.Class("w-24 shrink-0 max-lg:hidden")], [statusBadge(h, investigation.status)]),
					relativeTime(h, {
						value: investigation.updated_at,
						nowMs,
						timeZone,
						tooltip: "title",
						className: "w-13 shrink-0 text-right text-xs text-muted-foreground",
					}),
				],
			),
		},
		[h.Key(investigation.id), h.Attribute(ROW_ATTRIBUTE, investigation.id)],
	)
}

/** `InvestigationTableSkeleton`: ghosts the row rhythm. */
const tableSkeleton = (h: H): Html =>
	skeletonList(h, {
		rows: 5,
		gap: "0",
		label: "Loading investigations",
		renderRow: (index) =>
			h.div(
				[
					h.Key(String(index)),
					h.Class("flex items-center gap-3.5 border-b px-4 py-3.5 last:border-b-0"),
				],
				[
					skeleton(h, "size-3.5 shrink-0 rounded-full"),
					h.div(
						[h.Class("flex min-w-0 flex-1 flex-col gap-2")],
						[skeleton(h, "h-3.5 w-[45%]"), skeleton(h, "h-3 w-[70%]")],
					),
					skeleton(h, "h-3 w-20 shrink-0 max-md:hidden"),
					skeleton(h, "h-4 w-14 shrink-0 max-sm:hidden"),
					skeleton(h, "h-4 w-20 shrink-0 max-lg:hidden"),
					skeleton(h, "h-3 w-10 shrink-0"),
				],
			),
	})

const hubEmpty = (h: H, view: HubView, isFiltered: boolean): Html => {
	if (isFiltered)
		return filteredEmpty(h, {
			noun: "investigations",
			description: `Nothing in ${view === "active" ? "Active" : "History"} matches the kind or search you picked.`,
			onClear: Message.ClickedClearFilters(),
		})
	return empty(h, [
		emptyHeader(h, [
			emptyTitle(h, [
				view === "active" ? "Nothing under investigation" : "No finished investigations yet",
			]),
			emptyDescription(h, [
				view === "active"
					? "Start one above, or open an issue and choose Start investigation. When an alert rule fires, Maple opens one on its own."
					: "Investigations you resolve, and any that fail, stay here for reference.",
			]),
		]),
		emptyContent(h, [docsLink(h, "incidents")]),
	])
}

const HERO_SUGGESTIONS = [
	"Why did checkout latency spike this afternoon?",
	"What changed before the last error burst?",
	"Which service is slowest right now, and why?",
]

const HUB_TITLE = "Ask, and Maple goes and finds out."

/** `HubHero`: the first-run page. */
const hubHero = (h: H, model: Model): Html => {
	const presence = presenceOf(model.presence, "traces")
	return h.div(
		[h.Class("mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-5 py-16")],
		[
			eyebrow(h, { className: "text-primary" }, ["Investigations"]),
			h.header(
				[h.Class("flex flex-wrap items-start gap-x-6 gap-y-3")],
				[
					h.div(
						[h.Class("min-w-0 flex-1 space-y-1")],
						[
							h.div(
								[h.Class("flex flex-wrap items-baseline gap-3")],
								[
									pageTitle(h, { className: "min-w-0 whitespace-normal text-foreground" }, [
										HUB_TITLE,
									]),
								],
							),
							h.p(
								[h.Class("max-w-2xl text-sm text-muted-foreground")],
								[
									"One agent reads the traces, logs and metrics around it, tests the likely explanations (deploys, dependencies, saturation, traffic) and comes back with a cause, the evidence for it, and what it ruled out.",
								],
							),
						],
					),
				],
			),
			...(presence.status === "absent"
				? [
						h.div(
							[
								h.Class(
									"flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground",
								),
							],
							[
								h.span([], ["Investigations read your telemetry. Send traces first."]),
								linkButton(
									h,
									{
										size: "sm",
										className: "gap-2",
										href: hrefOf(AppRoute.Settings({ search: { tab: "ingestion" } })),
									},
									[icon(h, "ConnectionIcon"), "Set up tracing"],
								),
								docsLink(h, "instrumentation", "Setup guide"),
							],
						),
					]
				: []),
			bar(h, model, true, "A service, a symptom, a question…"),
			h.ul(
				[h.Class("flex flex-col gap-2")],
				HERO_SUGGESTIONS.map((suggestion) =>
					h.li(
						[h.Key(suggestion)],
						[
							h.button(
								[
									h.Type("button"),
									...(model.isCreating ? [h.Disabled(true)] : []),
									h.OnClick(Message.ClickedSuggestion({ title: suggestion })),
									h.Class(
										"flex w-full items-center gap-3 rounded-md border bg-card px-3.5 py-2.5 text-left text-sm text-foreground transition-colors hover:border-ring hover:bg-accent/50 disabled:opacity-60",
									),
								],
								[
									h.span(
										[h.AriaHidden(true), h.Class("shrink-0 text-muted-foreground")],
										["›"],
									),
									suggestion,
								],
							),
						],
					),
				),
			),
			h.div(
				[h.Class("flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm text-muted-foreground")],
				[
					h.p(
						[h.Class("flex items-baseline gap-2")],
						[
							statusDot(h, { tone: "custom", className: "translate-y-[-2px] bg-primary" }),
							"When an alert rule fires, Maple opens an investigation on its own. Those land here too.",
						],
					),
					h.a(
						[
							h.Href(hrefOf(AppRoute.AlertsCreate({ search: {} }))),
							h.Class("text-foreground underline-offset-4 hover:underline"),
						],
						["Create an alert rule"],
					),
					docsLink(h, "incidents"),
				],
			),
		],
	)
}

/** `BudgetExhaustedNotice`. */
const budgetNotice = (h: H, model: Model, timeZone: string): Html | null => {
	const budget = AsyncData.getOrElse(model.budget.data, () => null)
	if (budget === null || !budget.enabled || !budget.ordinaryPaused) return null
	const resets =
		budget.resumesAt === null
			? "."
			: `; it resets ${formatTimestampInTimezone(toEpochMs(budget.resumesAt), { timeZone, style: "range" })}.`
	const spent =
		budget.pausedDimension === "runs" || budget.pausedDimension === "runs_reserved"
			? "Today's investigation limit is reached"
			: "Today's model budget is spent"
	const canEditSettings = model.isOrgAdmin
	return alert(h, { variant: "warn", className: "mb-4" }, [
		alertTitle(
			h,
			[
				budget.priorityPaused
					? "Automatic triage paused"
					: "Automatic triage paused for routine incidents",
			],
			"text-foreground",
		),
		alertDescription(h, [
			h.span(
				[],
				[
					spent,
					resets,
					" ",
					budget.priorityPaused
						? "Nothing new will start until then."
						: "High and critical incidents still start.",
				],
			),
		]),
		...(canEditSettings
			? [
					alertAction(h, [
						linkButton(
							h,
							{
								size: "sm",
								variant: "ghost",
								href: hrefOf(AppRoute.Settings({ search: { tab: "ai" } })),
							},
							["Raise the limit"],
						),
					]),
				]
			: []),
	])
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	const all = allOf(model)
	const isFirstRun = AsyncData.isSuccess(model.firstPage.data) && all.length === 0
	if (isFirstRun) return dashboardPage(h, {}, [hubHero(h, model)])
	const visible = visibleOf(model, all)
	const isLoadingMore = isLoadingMoreOf(model)
	const hasMore = nextCursorOf(model) !== null || isLoadingMore
	const isFiltered = (model.search.q ?? "").trim().length > 0 || model.search.kind !== undefined
	const notice = budgetNotice(h, model, timeZone)
	const body = AsyncData.match(model.firstPage.data, {
		onIdle: () => tableSkeleton(h),
		onLoading: () => tableSkeleton(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load investigations",
				onRetry: Message.ClickedRetry(),
			}),
		onStale: ({ error }) =>
			errorState(h, {
				failure: error,
				title: "Couldn't load investigations",
				onRetry: Message.ClickedRetry(),
			}),
		onSuccess: () => loaded(),
		onRefreshing: () => loaded(),
	})
	function loaded(): Html {
		if (visible.length === 0) return hubEmpty(h, viewOf(model.search), isFiltered)
		return h.div(
			[h.Class("contents")],
			[
				h.ul(
					[h.Class("flex flex-col"), h.OnMount(MountInvestigationRows())],
					visible.map((investigation) => row(h, investigation, model.nowMs, timeZone)),
				),
				...(hasMore
					? [
							h.div(
								[h.Class("flex justify-center border-t py-3")],
								[
									button(
										h,
										{
											variant: "outline",
											size: "sm",
											isLoading: isLoadingMore,
											attributes: [h.OnClick(Message.ClickedLoadMore())],
										},
										["Load more"],
									),
								],
							),
						]
					: []),
			],
		)
	}
	// A failed load shows the error block bare: inside the panel it would double the border.
	const isFailed = AsyncData.isFailure(model.firstPage.data) || AsyncData.hasError(model.firstPage.data)
	const filters = (isFramed: boolean) =>
		toolbar(
			h,
			model,
			all,
			visible,
			hasMore,
			AsyncData.hasData(model.firstPage.data) && !AsyncData.hasError(model.firstPage.data),
			isFramed,
		)
	return dashboardPage(
		h,
		{
			title: "Investigations",
			sticky: h.div([h.Class("contents")], [...(notice === null ? [] : [notice]), bar(h, model)]),
		},
		[
			isFailed
				? h.div([h.Class("shrink-0")], [filters(false), body])
				: panel(h, { className: "shrink-0" }, [filters(true), body]),
		],
	)
})
