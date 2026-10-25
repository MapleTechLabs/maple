import { formatNumber, formatRate, pluralize } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { ReleaseHealth } from "../../../components/releases/release-model"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { activeFilterChips } from "../../../ui/filters/active-filter-chips"
import { inlineCode } from "../../../ui/inline-code"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { tableSkeleton } from "../../../ui/table-skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { docsLink } from "../../kit/signal-empty-state"
import { timeControls } from "../../kit/time-controls"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { RELEASE_HEALTH_LABEL } from "../kit"
import { commitsOf, DEFAULT_PRESET, deriveOf, issueCountsOf, rangesOf } from "./derive"
import { Message } from "./message"
import type { Model, ReleasesData } from "./model"
import { filtersRail } from "./view-filters"
import { liveNow, releasesTimeline, type TimeSearch } from "./view-overview"
import { releasesTable } from "./view-table"

// TODO(session-range): `sessionTimeRangeSearchMiddleware` (the range carried across pages).

type H = HtmlBuilder<Message>

const chipsOf = (model: Model) => {
	const { search } = model
	return [
		...(search.excludedEnvironments?.length
			? [{ id: "excludedEnvironments" as const, label: "Environment", values: search.excludedEnvironments, isNegated: true }]
			: []),
		...(search.environments?.length
			? [{ id: "environments" as const, label: "Environment", values: search.environments, isNegated: false }]
			: []),
		...(search.services?.length ? [{ id: "services" as const, label: "Service", values: search.services, isNegated: false }] : []),
		...(search.impact !== undefined
			? [{ id: "impact" as const, label: "Health", values: [RELEASE_HEALTH_LABEL[search.impact]], isNegated: false }]
			: []),
	].map((chip) => ({ ...chip, onRemove: Message.RemovedFilterChip({ param: chip.id }) }))
}

const loadingSkeleton = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-3")],
		[
			skeleton(h, "h-4 w-64"),
			skeleton(h, "h-52 w-full rounded-md"),
			tableSkeleton(h, {
				rows: 8,
				columns: [
					{ header: "Release", headClassName: "w-[46%] min-w-[260px]", skeleton: "w-48" },
					{ header: "Services" },
					{ header: "Deployed", headClassName: "whitespace-nowrap" },
					{ header: "Error rate", headClassName: "whitespace-nowrap", skeleton: "w-12" },
					{ header: "p95", skeleton: "w-12" },
					{ header: "Issues", skeleton: "w-8" },
				],
			}),
		],
	)

const stat = (h: H, value: string, rest: ReadonlyArray<string>, valueClass = "text-foreground"): Html =>
	h.span([], [h.span([h.Class(`font-medium tabular-nums ${valueClass}`)], [value]), " ", ...rest])

const timeSearchOf = (model: Model): TimeSearch => ({
	startTime: model.search.startTime,
	endTime: model.search.endTime,
	timePreset: model.search.timePreset,
})

const loaded = (h: H, model: Model, data: ReleasesData, isWaiting: boolean, timeZone: string): Html => {
	const { impacts, groups, live, response } = deriveOf(data)
	const health: ReleaseHealth | undefined = model.search.impact
	const visibleGroups = health === undefined ? groups : groups.filter((group) => group.health === health)
	const visibleImpacts = health === undefined ? impacts : impacts.filter((impact) => impact.health === health)
	const services = new Set(impacts.map((impact) => impact.serviceName)).size
	const windowDays = Math.max(1 / 24, (toEpochMs(response.endTime) - toEpochMs(response.startTime)) / 86_400_000)
	const flagged = groups.filter((group) => group.health === "regressed").length
	const timeSearch = timeSearchOf(model)
	if (groups.length === 0)
		return panel(h, {}, [
			emptyMessage(h, { className: "flex flex-col items-center gap-1 py-12 text-sm" }, [
				h.span([], ["No releases detected in this window."]),
				h.span(
					[h.Class("text-xs text-muted-foreground/70")],
					[
						"Releases compare errors and latency before and after each deploy. Release tracking needs spans to carry the ",
						inlineCode(h, {}, ["vcs.ref.head.revision"]),
						" resource attribute.",
					],
				),
				h.span([h.Class("mt-2")], [docsLink(h, "github")]),
			]),
		])
	const issues = AsyncData.getOrElse(model.issues.data, () => null)
	const live_ = liveNow(h, live, timeSearch, model.search.environments)
	return h.div(
		[h.Class("flex flex-col gap-3")],
		[
			h.div(
				[h.Class("flex flex-wrap items-baseline gap-x-5 gap-y-1 px-0.5 text-xs text-muted-foreground")],
				[
					stat(h, formatNumber(groups.length), [pluralize(groups.length, "release")]),
					stat(h, formatNumber(services), [pluralize(services, "service")]),
					stat(h, formatRate(groups.length / windowDays), ["per day"]),
					...(flagged > 0
						? [stat(h, formatNumber(flagged), [pluralize(flagged, "release"), " with errors up"], "text-severity-error")]
						: []),
					h.span([h.Class("text-muted-foreground/70")], ["Each release is compared with the version it replaced"]),
					...(response.truncated
						? [h.span([h.Class("text-muted-foreground/70")], ["Showing the newest ", formatNumber(response.releases.length), " rows"])]
						: []),
				],
			),
			...(live_ === null ? [] : [live_]),
			releasesTimeline(h, {
				impacts: visibleImpacts,
				startTime: response.startTime,
				endTime: response.endTime,
				timeSearch,
				environments: model.search.environments,
				trackWidth: model.trackWidth,
				nowMs: model.nowMs,
				timeZone,
			}),
			visibleGroups.length === 0
				? panel(h, {}, [
						emptyMessage(h, { className: "flex flex-col items-center gap-3 text-sm" }, [
							"No releases match the health filter.",
							button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedClearHealthFilter())] }, [
								"Clear filter",
							]),
						]),
					])
				: h.div(
						[h.Class("flex flex-col gap-1.5")],
						[
							releasesTable(h, {
								groups: visibleGroups,
								issueCounts: issueCountsOf(impacts, issues),
								timeSearch,
								environments: model.search.environments,
								isWaiting,
								commits: commitsOf(model),
								ranges: rangesOf(model),
								expanded: model.expanded,
								nowMs: model.nowMs,
								timeZone,
								overlays: {
									model: model.overlays,
									toParent: (message) => Message.GotOverlaysMessage({ message }),
									clock: { nowMs: model.nowMs, timeZone },
								},
							}),
							...(issues?.hasMore === true
								? [
										h.span(
											[h.Class("px-0.5 text-2xs text-muted-foreground/70")],
											["Issue counts cover the 100 most recently active issues introduced in this window."],
										),
									]
								: []),
						],
					),
		],
	)
}

const content = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.match(model.releases.data, {
		onIdle: () => loadingSkeleton(h),
		onLoading: () => loadingSkeleton(h),
		onFailure: (failure) => errorState(h, { failure, title: "Failed to load releases", onRetry: Message.ClickedRetry() }),
		onStale: ({ error }) => errorState(h, { failure: error, title: "Failed to load releases", onRetry: Message.ClickedRetry() }),
		onSuccess: (data) => loaded(h, model, data, false, timeZone),
		onRefreshing: (data) => loaded(h, model, data, true, timeZone),
	})

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const chips = activeFilterChips(h, { chips: chipsOf(model) })
	return dashboardPage(
		h,
		{
			title: "Releases",
			filters: filtersRail(h, model),
			actions: timeControls(h, {
				search: model.search,
				defaultPreset: DEFAULT_PRESET,
				window: model.window,
				onReset: Message.ClickedResetTimeRange(),
				onReload: Message.ClickedReload(),
				isReloading: model.isReloading,
				trigger: (label) =>
					h.submodel({
						slotId: "releases-time-range-picker",
						model: model.timePicker,
						view: TimeRangePicker.view,
						toParentMessage: toTimePicker,
						viewInputs: {
							label,
							selectedPreset: model.search.timePreset ?? (model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
							presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
						},
					}),
			}),
		},
		[...(chips === null ? [] : [chips]), content(h, model, inputs.context.timeZone)],
	)
})
