import type { CostSourceSummary } from "@maple/domain/http"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { BAR_CHART_TOKENS } from "@maple/views/charts/bar-chart"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { failureKey } from "@maple/views/data/load-failure"
import type * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { AppRoute, hrefOf } from "../../route"
import { linkButton } from "@maple/views/ui/button"
import { chartLoading } from "@maple/views/ui/chart-state"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyFrameClass,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { activeFilterChips } from "@maple/views/ui/filters/active-filter-chips"
import { icon } from "@maple/views/ui/icon"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { grid } from "@maple/views/ui/grid"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { hstack, vstack } from "@maple/views/ui/stack"
import { tableSkeleton } from "@maple/views/ui/table-skeleton"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { COST_GROUP_BYS } from "../../route/search"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { pageTime } from "../kit/page-time"
import { statRailLoading } from "../kit/stat-rail"
import { DAY_RANGE_PRESET_VALUES } from "../kit/time-controls"
import { activeFilters, DIMENSIONS, groupByOf, hasSynced, keyLabel } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { dailyChart } from "./view-chart"
import { figuresRow } from "./view-figures"
import { SOURCES_HREF, sourcesSection } from "./view-sources"
import { breakdownTable } from "./view-table"

type H = HtmlBuilder<Message>

const CONNECT_AWS_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "aws" } }))

/** No cost source: how to get one. Never a sample of what the page would show. */
const onRamp = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(
				h,
				[
					emptyMedia(h, { variant: "icon" }, [icon(h, "CircleDollarIcon")]),
					emptyTitle(h, ["No cost source yet"]),
					emptyDescription(h, [
						"Connect an AWS account and turn on its Cost module. Maple then reads what the account spends each day, by service, region and usage type.",
					]),
					emptyDescription(
						h,
						[
							"AWS bills Cost Explorer requests at USD\u00a00.01 each. Maple makes a few a day for each account, which comes to a few dollars a month.",
						],
						"mt-3",
					),
				],
				"max-w-md",
			),
			emptyContent(
				h,
				[
					emptyActions(h, [
						linkButton(h, { variant: "default", size: "sm", href: CONNECT_AWS_HREF }, [
							"Connect AWS",
						]),
						textLink(h, { href: SOURCES_HREF, tone: "muted" }, ["Open your sources"]),
					]),
				],
				"max-w-md",
			),
		],
		emptyFrameClass("dashed"),
	)

/** Sources exist and none has cost yet: what the reader is waiting for. */
const firstSync = (h: H, sources: ReadonlyArray<CostSourceSummary>): Html => {
	const isWaiting = Arr.some(sources, (source) => source.status === "pending")
	const isFailing = Arr.some(sources, (source) => source.status === "error")
	return empty(
		h,
		[
			emptyHeader(
				h,
				[
					emptyMedia(h, { variant: "icon" }, [
						icon(h, isWaiting ? "ClockIcon" : "CircleDollarIcon"),
					]),
					emptyTitle(h, [
						isWaiting
							? "Waiting for the first sync"
							: isFailing
								? "The first sync failed"
								: "No source supplies cost",
					]),
					emptyDescription(h, [
						isWaiting
							? "The first sync runs within the hour. It brings in the last few days, and older days fill in after that."
							: isFailing
								? "Maple tries again within the hour. The source below shows what went wrong."
								: "Each source below is paused. Turn the Cost module back on for a connection to read its cost.",
					]),
				],
				"max-w-md",
			),
		],
		emptyFrameClass("dashed", "md:py-12"),
	)
}

const loading = (h: H): Html =>
	vstack(h, { gap: "6" }, [
		statRailLoading(h, 3, 3),
		chartLoading(h, { variant: "bar", height: 300 }),
		tableSkeleton(h, { columns: 5, rows: 6 }),
	])

/** Group by on the left, the filters in effect beside it. */
const toolbar = (h: H, model: Model): Html => {
	const chips = activeFilterChips(h, {
		chips: Arr.map(activeFilters(model.search), (filter) => ({
			id: `${filter.dimension}:${filter.value}`,
			label: DIMENSIONS[filter.dimension].label,
			values: [keyLabel(filter.dimension, filter.value)],
			onRemove: Message.ClickedRemoveFilter(filter),
		})),
		onClearAll: Message.ClickedClearFilters(),
		className: "mb-0",
	})
	return hstack(h, { gap: "4", wrap: true, className: "gap-y-2" }, [
		hstack(h, { gap: "2" }, [
			typography(h, { size: "xs", tone: "muted" }, ["Group by"]),
			segmentedSelect(h, {
				ariaLabel: "Group by",
				size: "sm",
				value: groupByOf(model.search),
				options: Arr.map(COST_GROUP_BYS, (dimension) => ({
					value: dimension,
					label: DIMENSIONS[dimension].label,
				})),
				onChange: (groupBy) => Message.PickedGroupBy({ groupBy }),
			}),
		]),
		...(chips === null ? [] : [chips]),
	])
}

const failureOf = (slot: Keyed.Keyed<unknown, LoadFailure>): LoadFailure | undefined =>
	Option.getOrUndefined(AsyncData.getData(slot.data)) === undefined && AsyncData.isFailure(slot.data)
		? Option.getOrUndefined(AsyncData.getError(slot.data))
		: undefined

/** Every read failed the same way (an outage): one block says so, not three. */
const sharedFailure = (model: Model): LoadFailure | undefined => {
	const failures = [failureOf(model.totals), failureOf(model.timeseries), failureOf(model.breakdown)]
	const first = failures[0]
	return first !== undefined &&
		Arr.every(failures, (failure) => failure !== undefined && failureKey(failure) === failureKey(first))
		? first
		: undefined
}

const content = (h: H, model: Model): ReadonlyArray<Html> => {
	const failure = sharedFailure(model)
	return failure === undefined
		? [figuresRow(h, model), toolbar(h, model), dailyChart(h, model), breakdownTable(h, model)]
		: [
				toolbar(h, model),
				errorState(h, { failure, title: "Couldn't load cost", onRetry: Message.ClickedRetry() }),
			]
}

/** Whether the window's reads are on the page: only then does the header offer a day range. */
const showsData = (model: Model): boolean =>
	Option.exists(AsyncData.getData(model.sources.data), (response) => hasSynced(response.sources))

const body = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> =>
	AsyncData.matchData(model.sources.data, {
		onEmpty: () => [loading(h)],
		onFailure: (failure) => [
			errorState(h, { failure, title: "Couldn't load cost", onRetry: Message.ClickedRetry() }),
		],
		onData: ({ sources }) => {
			if (sources.length === 0) return [onRamp(h)]
			const section = sourcesSection(h, sources, model.nowMs, timeZone)
			return hasSynced(sources) ? [...content(h, model), section] : [firstSync(h, sources), section]
		},
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: BAR_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					title: "Cost",
					actions: showsData(model)
						? pageTime(h, {
								search: model.search,
								defaultPreset: DEFAULT_PRESET,
								presets: DAY_RANGE_PRESET_VALUES,
								window: model.window,
								picker: model.timePicker,
								toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
								onReset: Message.ClickedResetTimeRange(),
								onReload: Message.ClickedReload(),
								isReloading: model.isReloading,
							})
						: undefined,
				},
				// A grid, not the scroll column's own flex: there a panel (it clips) is squeezed by a
				// growing sibling such as the error state.
				[
					grid(
						h,
						{ cols: 1, gap: "6", className: "shrink-0" },
						body(h, model, inputs.context.timeZone),
					),
				],
			),
		],
	),
)
