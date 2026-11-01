import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { initialsFrom } from "@maple/ui/lib/initials"
import { Submodel } from "foldkit"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { listFooter, loadingMoreRow } from "../../../ui/list-footer"
import { button } from "../../../ui/button"
import { truncatedText } from "../../../ui/truncated-text"
import { AppRoute, hrefOf } from "../../../route"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { toolbarStat } from "../../kit/list-toolbar"
import { presenceOf } from "../../kit/signal-presence"
import { signalEmptyState } from "../../kit/signal-empty-state"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { replaysToolbar } from "../kit/replays-toolbar"
import { sessionListItems } from "../kit/session-row"
import { sessionsList, sessionsListSkeleton } from "../kit/sessions-list"
import { VirtualizeList, WatchListEnd } from "./command"
import {
	allRows,
	collapsesLowSignal,
	engagedCount,
	facetsOf,
	hasActiveFilters,
	isCapped,
	listEndKey,
	nextCursor,
	selectedTags,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { filtersRail } from "./view-filters"
import { warmAvatarTone } from "../../../ui/avatar-tone"

type H = HtmlBuilder<Message>

const AUTO_LOAD_MIN_ROWS = 25

const headerActions = (h: H, model: Model): Html => {
	const facets = facetsOf(model)
	const { search } = model
	return h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
			...(facets === undefined
				? []
				: [
						h.div(
							[h.Class("hidden items-center gap-3 sm:flex")],
							[
								toolbarStat(h, {
									value: formatNumber(facets.totalSessions),
									label: "sessions",
								}),
								...(facets.liveSessions > 0
									? [
											toolbarStat(h, {
												value: formatNumber(facets.liveSessions),
												label: "live",
												dot: "ok",
											}),
										]
									: []),
							],
						),
					]),
			linkButton(
				h,
				{
					variant: "outline",
					size: "sm",
					href: hrefOf(
						AppRoute.Analytics({
							search: {
								startTime: search.startTime,
								endTime: search.endTime,
								timePreset: search.timePreset,
							},
						}),
					),
					attributes: [h.AriaLabel("View web analytics")],
				},
				[icon(h, "ChartBarHorizontalIcon"), h.span([h.Class("hidden sm:inline")], ["Analytics"])],
			),
		],
	)
}

/** `ActiveUserFilter`: the banner over the list while a user or visitor filter is set. */
const activeUserFilter = (
	h: H,
	config: Readonly<{ userId: string; count: number; label: string; clearLabel: string; onClear: Message }>,
): Html =>
	h.div(
		[h.Class("mb-3 flex items-center gap-3 rounded-md border border-primary-a3 bg-primary-a1 px-3 py-2")],
		[
			h.div(
				[
					h.Class(
						`grid size-8 shrink-0 place-items-center rounded-full ${warmAvatarTone(config.userId)} text-xs font-semibold`,
					),
				],
				[initialsFrom(config.userId)],
			),
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					h.div(
						[h.Class("flex items-baseline gap-2")],
						[
							h.span([h.Class("text-xs text-muted-foreground")], [config.label]),
							truncatedText(h, {
								text: config.userId,
								mono: true,
								tooltip: "none",
								className: "text-sm font-medium",
							}),
						],
					),
					h.span(
						[h.Class("text-xs text-muted-foreground tabular-nums")],
						[countLabel(config.count, "session"), " loaded"],
					),
				],
			),
			iconButton(
				h,
				{
					label: config.clearLabel,
					className: "rounded-full text-muted-foreground before:rounded-full",
					attributes: [h.OnClick(config.onClear)],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	)

/** The sentinel or the Load more button, then the cap footer and the loading row. */
const listFooterParts = (
	h: H,
	model: Model,
	items: ReturnType<typeof sessionListItems>,
): ReadonlyArray<Html> => {
	const hasMore = nextCursor(model) !== null
	const { isFetching } = model.pagination
	const hidesSessions = items.some((item) => item.kind === "quiet" && !item.expanded)
	const last = items.at(-1)
	const endsInFoldedRun = last?.kind === "quiet" && !last.expanded
	const isManual = hidesSessions && (items.length < AUTO_LOAD_MIN_ROWS || endsInFoldedRun)
	const capped = isCapped(model)
		? listFooter(h, {
				shown: allRows(model).length,
				noun: "sessions",
				isCapped: true,
				align: "start",
				className: "px-0",
			})
		: null
	return [
		...(hasMore
			? [
					isManual
						? h.div(
								[h.Class("flex justify-center py-3")],
								[
									button(
										h,
										{
											variant: "outline",
											size: "sm",
											isLoading: isFetching,
											attributes: [h.OnClick(Message.ClickedLoadMore())],
										},
										["Load more sessions"],
									),
								],
							)
						: h.div(
								[
									h.Key(listEndKey(model)),
									h.AriaHidden(true),
									h.DataAttribute("replays-list-end", ""),
									h.Class("h-px w-full"),
									h.OnMount(WatchListEnd()),
								],
								[],
							),
				]
			: []),
		...(capped === null ? [] : [capped]),
		...(isFetching ? [h.div([h.Class("py-6")], [loadingMoreRow(h, "Loading more sessions…")])] : []),
	]
}

const listBody = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.firstPage.data, {
		onEmpty: () => sessionsListSkeleton(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load session replays",
				onRetry: Message.ClickedRetryList(),
			}),
		onData: () => {
			const rows = allRows(model)
			if (rows.length === 0)
				return h.div(
					[h.Class("contents")],
					[
						signalEmptyState(h, {
							signal: "sessions",
							presence: presenceOf(model.presence, "sessions"),
							nowMs: model.nowMs,
							isFiltered: hasActiveFilters(model.search),
							onClearFilters: Message.ClickedClearFilters(),
						}),
					],
				)
			const items = sessionListItems(rows, {
				collapse: collapsesLowSignal(model.search),
				expanded: model.expandedRuns,
				nowMs: model.nowMs,
			})
			return sessionsList(
				h,
				{
					items,
					nowMs: model.nowMs,
					timeZone,
					durationP95: facetsOf(model)?.durationP95,
					onOpen: (session) =>
						Message.ClickedSession({
							sessionId: session.sessionId,
							startTime: session.startTime,
						}),
					onToggleRun: (key) => Message.ToggledRun({ key }),
					onFilterTag: (tag) => Message.ClickedRowTag({ tag }),
					onFilterGroup: (group) => Message.ClickedRowGroup({ group }),
				},
				{ window: model.virtualWindow, mount: h.OnMount(VirtualizeList()) },
				listFooterParts(h, model, items),
			)
		},
	})

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const { search } = model
	const rowCount = allRows(model).length
	const timeCluster = timeControls(h, {
		search,
		defaultPreset: DEFAULT_PRESET,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "time-range-picker",
				model: model.timePicker,
				view: TimeRangePicker.view,
				toParentMessage: toTimePicker,
				viewInputs: {
					label,
					selectedPreset:
						search.timePreset ?? (search.startTime === undefined ? DEFAULT_PRESET : undefined),
					presets: TimeRangePicker.PRESET_VALUES,
				},
			}),
	})
	return dashboardPage(
		h,
		{
			title: "Replays",
			filters: filtersRail(h, model),
			actions: h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[headerActions(h, model), timeCluster],
			),
			sticky: replaysToolbar(h, {
				query: model.query,
				onInput: (value) => Message.ChangedQuery({ value }),
				onClear: Message.ClickedClearQuery(),
				errorSessions: facetsOf(model)?.errorCount,
				isErrorsOnly: search.hasErrors === true,
				onToggleErrorsOnly: Message.ToggledErrorsOnly(),
				engagedSessions: engagedCount(model),
				isEngagedOnly: selectedTags(search).includes("engaged"),
				onToggleEngagedOnly: Message.ToggledEngagedOnly(),
				isWaiting:
					AsyncData.isIdle(model.firstPage.data) ||
					AsyncData.isLoading(model.firstPage.data) ||
					AsyncData.isRefreshing(model.firstPage.data),
			}),
		},
		[
			...(search.userId !== undefined && search.userId !== ""
				? [
						activeUserFilter(h, {
							userId: search.userId,
							count: rowCount,
							label: "Sessions from",
							clearLabel: "Clear user filter",
							onClear: Message.ClickedClearUserId(),
						}),
					]
				: []),
			...(search.visitorId !== undefined && search.visitorId !== ""
				? [
						activeUserFilter(h, {
							userId: search.visitorId,
							count: rowCount,
							label: "Sessions from visitor",
							clearLabel: "Clear visitor filter",
							onClear: Message.ClickedClearVisitor(),
						}),
					]
				: []),
			...(search.groupId !== undefined && search.groupId !== ""
				? [
						activeUserFilter(h, {
							userId: search.groupId,
							count: rowCount,
							label: "Sessions from group",
							clearLabel: "Clear group filter",
							onClear: Message.ClickedClearGroupId(),
						}),
					]
				: []),
			listBody(h, model, inputs.context.timeZone),
		],
	)
})
