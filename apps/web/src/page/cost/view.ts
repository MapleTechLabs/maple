import { CostProvider } from "@maple/domain/cost"
import type { CostSourceSummary } from "@maple/domain/http"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { BAR_CHART_TOKENS } from "@maple/views/charts/bar-chart"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { failureKey } from "@maple/views/data/load-failure"
import type * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { button } from "@maple/views/ui/button"
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
import { refreshButton } from "@maple/views/ui/refresh-button"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { grid } from "@maple/views/ui/grid"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { hstack, vstack } from "@maple/views/ui/stack"
import { tableSkeleton } from "@maple/views/ui/table-skeleton"
import { typography } from "@maple/views/ui/typography"
import { COST_GROUP_BYS } from "../../route/search"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { pageTime } from "../kit/page-time"
import { statRailLoading } from "../kit/stat-rail"
import { DAY_RANGE_PRESET_VALUES } from "../kit/time-controls"
import { activeFilters, DIMENSIONS, groupByOf, hasSynced, keyLabel } from "./derive"
import { Message } from "./message"
import { LONG_RANGE_MAX_SECONDS } from "../../route/session-time-range"
import { keyMark } from "./marks"
import { canManageSources, cannotManageSources, sourcesOf, type Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { addSourceDialog, removeSourceDialog } from "./view-add-source"
import { dailyChart } from "./view-chart"
import { filtersRail } from "./view-filters"
import { figuresRow } from "./view-figures"
import { sourcesSection } from "./view-sources"
import { breakdownTable } from "./view-table"

const DAY_SECONDS = 24 * 60 * 60

type H = HtmlBuilder<Message>

/** No cost source: how to get one. Never a sample of what the page would show. */
const onRamp = (
	h: H,
	options: Readonly<{ canManage: boolean; cannotManage: boolean; isBusy: boolean }>,
): Html =>
	empty(
		h,
		[
			emptyHeader(
				h,
				[
					emptyMedia(h, { variant: "icon" }, [icon(h, "CircleDollarIcon")]),
					emptyTitle(h, ["No cost source yet"]),
					emptyDescription(h, [
						"Add a source and Maple reads what it bills each day: an AWS account by service, region and account, an OpenRouter account by model, a GitHub organization by product and repository, a Vercel team by product and project, a Cloudflare account by product.",
					]),
					// A member's save would be refused: say who can, and offer no form.
					...(!options.cannotManage
						? []
						: [
								emptyDescription(
									h,
									["Only organization admins and engineers can add a cost source."],
									"mt-3",
								),
							]),
				],
				"max-w-md",
			),
			...(options.canManage
				? [
						emptyContent(
							h,
							[
								emptyActions(h, [
									button(
										h,
										{
											variant: "default",
											size: "sm",
											isDisabled: options.isBusy,
											attributes: [h.OnClick(Message.ClickedAddSource())],
										},
										["Add a cost source"],
									),
								]),
							],
							"max-w-md",
						),
					]
				: []),
		],
		emptyFrameClass("dashed"),
	)

/** What a provider's first sync brings in: said on its own, and named beside other providers. */
const FIRST_SYNC = {
	aws: {
		alone: "It brings in this month and the last, and older months fill in after that.",
		named: "AWS brings in this month and the last, and older months fill in after that.",
	},
	openrouter: {
		alone: "It brings in the last four weeks, which is all OpenRouter keeps.",
		named: "OpenRouter brings in its last four weeks.",
	},
	github: {
		alone: "It brings in this month and the last, then the two months before.",
		named: "GitHub brings in this month and the last, then the two months before.",
	},
	vercel: {
		alone: "It brings in this month and the last, and older months fill in after that.",
		named: "Vercel brings in this month and the last, and older months fill in after that.",
	},
	cloudflare: {
		alone: "It brings in this month and the last, and older months fill in after that.",
		named: "Cloudflare brings in this month and the last, and older months fill in after that.",
	},
} as const satisfies Record<CostProvider, Readonly<{ alone: string; named: string }>>

/** What the first syncs bring in, by the providers that have no cost yet (waiting or failing alike). */
const firstSyncScope = (sources: ReadonlyArray<CostSourceSummary>): string => {
	const unsynced = Arr.filter(sources, (source) => source.watermarkDate === null)
	const providers = Arr.filter(CostProvider.literals, (provider) =>
		Arr.some(unsynced, (source) => source.provider === provider),
	)
	const [only, ...others] = providers
	if (only === undefined) return FIRST_SYNC.aws.alone
	return others.length === 0
		? FIRST_SYNC[only].alone
		: Arr.join(
				Arr.map(providers, (provider) => FIRST_SYNC[provider].named),
				" ",
			)
}

/** Sources exist and none has cost yet: what the reader is waiting for. */
const firstSync = (h: H, sources: ReadonlyArray<CostSourceSummary>): Html => {
	const isWaiting = Arr.some(sources, (source) => source.status === "pending")
	const isFailing = Arr.some(sources, (source) => source.status === "error")
	// Held before its first pull: nothing failed and nothing is paused, the row says why it waits.
	const isHeld = Arr.some(sources, (source) => source.status === "held")
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
								: isHeld
									? "No cost read yet"
									: "No source supplies cost",
					]),
					emptyDescription(h, [
						isWaiting
							? `The first sync runs within a few minutes. ${firstSyncScope(sources)}`
							: isFailing
								? "Maple tries again within the hour. The source below shows what went wrong."
								: isHeld
									? "The sync is on hold. The source below says why."
									: "Each source below is paused. Turn the Cost module back on for its connection to read its cost.",
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
			values: [keyLabel(filter.dimension, filter.value, sourcesOf(model))],
			mark: keyMark(filter.dimension, filter.value, sourcesOf(model)) ?? undefined,
			onRemove: Message.ClickedRemoveFilter(filter),
		})),
		onClearAll: Message.ClickedClearFilters(),
		className: "mb-0",
	})
	return hstack(h, { gap: "4", wrap: true, className: "gap-y-2" }, [
		hstack(h, { gap: "2", className: "min-w-0 max-w-full" }, [
			typography(h, { size: "xs", tone: "muted", className: "shrink-0" }, ["Group by"]),
			segmentedSelect(h, {
				ariaLabel: "Group by",
				size: "sm",
				// Six options outgrow a narrow page beside the rail: the group scrolls, not the page.
				className: "min-w-0 overflow-x-auto",
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

/** Sources are connected and none has cost yet. */
const isAwaitingCost = (model: Model): boolean =>
	Option.exists(
		AsyncData.getData(model.sources.data),
		(response) => response.sources.length > 0 && !hasSynced(response.sources),
	)

const body = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> =>
	AsyncData.matchData(model.sources.data, {
		onEmpty: () => [loading(h)],
		onFailure: (failure) => [
			errorState(h, { failure, title: "Couldn't load cost", onRetry: Message.ClickedRetry() }),
		],
		onData: ({ sources }) => {
			const isBusy = model.sourceWrite !== "Idle"
			const canManage = canManageSources(model)
			if (sources.length === 0) {
				return [onRamp(h, { canManage, cannotManage: cannotManageSources(model), isBusy })]
			}
			const section = sourcesSection(h, sources, model.nowMs, timeZone, { isBusy, canManage })
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
					// The rail filters the window's reads: it shows once there is cost to read.
					filters: showsData(model) ? filtersRail(h, model) : undefined,
					actions: showsData(model)
						? pageTime(h, {
								search: model.search,
								defaultPreset: DEFAULT_PRESET,
								presets: DAY_RANGE_PRESET_VALUES,
								// Cost is per whole day, and the page reads a year at most.
								maxRangeSeconds: LONG_RANGE_MAX_SECONDS,
								minRangeSeconds: DAY_SECONDS,
								window: model.window,
								picker: model.timePicker,
								toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
								onReset: Message.ClickedResetTimeRange(),
								onReload: Message.ClickedReload(),
								isReloading: model.isReloading,
							})
						: isAwaitingCost(model)
							? // The first sync lands while the page is open: Reload reads the sources again.
								refreshButton(h, {
									onRefresh: Message.ClickedReload(),
									isPending: model.isReloading,
									label: "Reload",
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
					addSourceDialog(h, model, sourcesOf(model)),
					removeSourceDialog(h, model),
				],
			),
		],
	),
)
