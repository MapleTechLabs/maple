import {
	derivePlanetScaleSetup,
	metricsCollectionFailing,
} from "../../../../components/integrations/planetscale-setup-steps"
import { countLabel } from "@maple/ui/lib/format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { button } from "../../../../ui/button"
import { textLink } from "../../../../ui/text-link"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { type SelectEntry, view as selectView } from "../../../../ui/select-view"
import * as Tooltip from "../../../../ui/tooltip"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHeroParts } from "../../../infra/kit/page-parts"
import { formatAbsolute } from "../../../kit/relative-time"
import { pageTime } from "../../kit/page-time"
import { activeFilterChips, applyBranchFilters } from "../filters"
import {
	BRANCH_ABSENCE_COPY,
	metricsNotice,
	planetscaleConnectCta,
	revokedNotice,
	setupState,
} from "../notices"
import {
	candidatesOf,
	databaseOf,
	eventsToChartMarkers,
	filtersOf,
	neverCollectedOf,
	resolutionOf,
	selectedBranchOf,
	statusOf,
} from "./derive"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { breakdownLoading, breakdownPanel } from "./view-breakdown"
import {
	branchScope,
	CHART_SCOPE_EXPLANATION,
	CHART_TOKENS,
	chartsSection,
	FALLBACK_EXPLANATION,
	type Trigger,
} from "./view-charts"
import { activitySection, eventTriggerId, insightTriggerId, topQueries } from "./view-sections"
import { sectionHeading } from "../../../kit/section-heading"
import { planetscaleSidebar } from "./view-sidebar"
import { absenceReason } from "../../../../components/infra/planetscale/branch-selection"

// `PlanetScaleDatabasePage`.
// TODO(alert-menu): "Alert on this" renders its trigger; the suggestion menu and its prefilled
// `/alerts/create` navigation (`encodeAlertChartToSearchParam`, `makeQueryDataSource`) are not ported.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const CHART_METRIC_IDS = [
	"storageUsedPercent",
	"connectionsAvg",
	"cpuMaxPercent",
	"memMaxPercent",
	"replicaLagMaxSeconds",
]

/** Every tooltip on the page: scope chips, event times, query last-run times. */
const tooltipIds = (model: Model): ReadonlyArray<string> => [
	...CHART_METRIC_IDS.flatMap((metric) => [`ps-chart-${metric}-all`, `ps-chart-${metric}-fallback`]),
	"ps-insights-all",
	"ps-insights-fallback",
	...AsyncData.getOrElse(model.events.data, () => []).map(eventTriggerId),
	...AsyncData.match(model.insights.data, {
		onIdle: () => [],
		onLoading: () => [],
		onFailure: () => [],
		onStale: () => [],
		onRefreshing: (data) => data.rows.map((row) => insightTriggerId(row.fingerprint)),
		onSuccess: (data) => data.rows.map((row) => insightTriggerId(row.fingerprint)),
	}),
]

const tooltipContent = (model: Model, clock: Clock, id: string): ReadonlyArray<string> => {
	if (id.endsWith("-all")) return [CHART_SCOPE_EXPLANATION]
	if (id === "ps-insights-fallback") return [FALLBACK_EXPLANATION.insights]
	if (id.endsWith("-fallback")) return [FALLBACK_EXPLANATION.chart]
	const event = AsyncData.getOrElse(model.events.data, () => []).find(
		(entry) => eventTriggerId(entry) === id,
	)
	if (event !== undefined) return [formatAbsolute(event.occurredAt, clock.timeZone)]
	const insight = AsyncData.match(model.insights.data, {
		onIdle: () => undefined,
		onLoading: () => undefined,
		onFailure: () => undefined,
		onStale: () => undefined,
		onRefreshing: (data) => data.rows.find((row) => insightTriggerId(row.fingerprint) === id),
		onSuccess: (data) => data.rows.find((row) => insightTriggerId(row.fingerprint) === id),
	})
	return insight?.lastRunAt === undefined || insight.lastRunAt === null
		? []
		: [formatAbsolute(insight.lastRunAt, clock.timeZone)]
}

const unknownBranchNotice = (h: H, name: string, fallback: string | null): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "PlanetScaleIcon", { size: 16 })]),
				emptyTitle(h, ["No branch named ", h.span([h.Class("font-mono")], [name])]),
				emptyDescription(h, [
					"It may have been deleted, or the inventory hasn't refreshed since it was created.",
				]),
			]),
			...(fallback === null
				? []
				: [
						emptyContent(h, [
							button(
								h,
								{
									size: "sm",
									variant: "outline",
									attributes: [h.OnClick(Message.SelectedBranch({}))],
								},
								["Show ", fallback],
							),
						]),
					]),
		],
		"py-10",
	)

const dataSections = (
	h: H,
	model: Model,
	clock: Clock,
	trigger: Trigger,
	theme: Model["themeColors"],
): Html => {
	const filters = filtersOf(model)
	const selected = filters.branches ?? []
	const candidates = applyBranchFilters(candidatesOf(model), filters)
	const selectedBranch = selectedBranchOf(model)
	const selectedCandidate = candidates.find((candidate) => candidate.name === selectedBranch?.name) ?? null
	const reason = selectedCandidate === null ? null : absenceReason(selectedCandidate)
	const events =
		AsyncData.isSuccess(model.events.data) || AsyncData.isRefreshing(model.events.data)
			? model.events.data.data
			: []
	const statsSlot = model.branchStats.data
	return h.div(
		[h.Class("space-y-6")],
		[
			...(neverCollectedOf(model)
				? []
				: [
						h.section(
							[h.Class("space-y-3")],
							[
								chartsSection(h, model, {
									theme,
									timeZone: clock.timeZone,
									markers: eventsToChartMarkers(events),
									emptyMessage: reason !== null ? BRANCH_ABSENCE_COPY[reason] : undefined,
									selected,
									trigger,
								}),
							],
						),
					]),
			activitySection(h, model.events.data, clock, trigger),
			h.section(
				[h.Class("space-y-2")],
				[
					AsyncData.match(statsSlot, {
						onIdle: () => breakdownLoading(h),
						onLoading: () => breakdownLoading(h),
						onFailure: (failure) =>
							errorState(h, {
								failure,
								title: "Couldn't load branch stats",
								onRetry: Message.ClickedRetryBranchStats(),
							}),
						onStale: ({ error }) =>
							errorState(h, {
								failure: error,
								title: "Couldn't load branch stats",
								onRetry: Message.ClickedRetryBranchStats(),
							}),
						onRefreshing: () =>
							breakdownPanel(h, {
								candidates,
								selectedBranches: selected,
								measure: model.measure,
								sort: model.breakdownSort,
								isWaiting: true,
								emptyMessage: "No branches match these filters.",
							}),
						onSuccess: () =>
							breakdownPanel(h, {
								candidates,
								selectedBranches: selected,
								measure: model.measure,
								sort: model.breakdownSort,
								isWaiting: false,
								emptyMessage: "No branches match these filters.",
							}),
					}),
				],
			),
			h.section(
				[h.Class("space-y-2")],
				[
					h.div(
						[h.Class("flex flex-wrap items-baseline justify-between gap-3")],
						[
							h.div(
								[h.Class("flex flex-wrap items-baseline gap-2")],
								[
									sectionHeading(h, { title: "Top queries" }),
									branchScope(h, {
										selected,
										resolved: selectedBranch?.name ?? null,
										surface: "insights",
										idPrefix: "ps-insights",
										trigger,
									}),
								],
							),
							h.span(
								[h.Class("text-2xs text-muted-foreground")],
								["PlanetScale Query Insights"],
							),
						],
					),
					topQueries(h, model.insights.data, model.dbName, clock, trigger),
				],
			),
		],
	)
}

const filterChipRail = (h: H, model: Model): ReadonlyArray<Html> => {
	const chips = activeFilterChips(filtersOf(model))
	if (chips.length === 0) return []
	const chipClass =
		"inline-flex items-center gap-1 rounded-sm border border-border-subtle bg-background/60 py-0.5 pr-0.5 pl-1.5 font-mono text-3xs text-muted-foreground"
	return [
		h.div(
			[h.Class("flex flex-wrap items-center gap-1.5"), h.AriaLabel("Active filters")],
			[
				...chips.slice(0, 6).map((chip) =>
					h.span(
						[h.Class(chipClass)],
						[
							h.span([h.Class("max-w-[22ch] truncate text-foreground-soft")], [chip.label]),
							button(
								h,
								{
									variant: "ghost",
									size: "icon-2xs",
									className: "text-muted-foreground hover:text-foreground",
									attributes: [
										h.AriaLabel(`Remove ${chip.label}`),
										h.OnClick(
											Message.RemovedFilterChip({ key: chip.key, value: chip.value }),
										),
									],
								},
								[icon(h, "XmarkIcon")],
							),
						],
					),
				),
				textLink(
					h,
					{
						tone: "muted",
						isMono: true,
						className: "ml-1 text-3xs",
						onClick: Message.ClickedClearFilters(),
					},
					["Clear all"],
				),
			],
		),
	]
}

const branchSelect = (h: H, model: Model, timeControls: Html): Html => {
	const candidates = candidatesOf(model)
	if (candidates.length === 0) return h.div([h.Class("flex flex-wrap items-center gap-2")], [timeControls])
	const selected = selectedBranchOf(model)
	return h.submodel({
		slotId: "planetscale-branch-select",
		model: { ...model.branchSelect, value: selected?.name ?? "" },
		view: selectView,
		toParentMessage: (message) => Message.GotBranchSelectMessage({ message }),
		viewInputs: {
			entries: candidates.map((candidate): SelectEntry => ({
				_tag: "Item",
				item: { value: candidate.name, label: candidate.name },
			})),
			ariaLabel: "Branch",
			size: "sm",
			className: "w-44 font-mono text-xs",
			renderItem: (option) => [
				option.label,
				...(candidates.find((c) => c.name === option.value)?.production === true
					? [" · production"]
					: []),
			],
			toView: (parts) =>
				h.div([h.Class("flex flex-wrap items-center gap-2")], [...parts, timeControls]),
		},
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	const status = statusOf(model)
	const database = databaseOf(model)
	const resolution = resolutionOf(model)
	const never = neverCollectedOf(model)
	const timeControls = pageTime(h, {
		search: model.search,
		defaultPreset: DEFAULT_PRESET,
		window: model.window,
		picker: model.timePicker,
		toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
	})
	const body = (trigger: Trigger): ReadonlyArray<Html> =>
		status !== null && !status.connected
			? [planetscaleConnectCta(h)]
			: [
					...(status?.revoked_at != null ? [revokedNotice(h)] : []),
					...(status !== null &&
					status.revoked_at === null &&
					!never &&
					metricsCollectionFailing(status, clock.nowMs)
						? [metricsNotice(h, status)]
						: []),
					...(never && status !== null
						? [setupState(h, derivePlanetScaleSetup(status, clock.nowMs).checks)]
						: []),
					...(resolution.kind === "unknown"
						? [unknownBranchNotice(h, resolution.name, resolution.fallback?.name ?? null)]
						: []),
					dataSections(h, model, clock, trigger, model.themeColors),
				]
	const heroActions: ReadonlyArray<Html> =
		database === null
			? []
			: [
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [h.AriaHasPopup("menu"), h.AriaExpanded(false)],
						},
						[icon(h, "BellIcon", { size: 14 }), "Alert on this"],
					),
				]
	const hero = pageHeroParts(h, {
		title: model.dbName,
		description: "Branch-level health, live from PlanetScale.",
		meta:
			database === null
				? undefined
				: [
						heroChip(h, database.kind === "postgresql" ? "Postgres" : "MySQL / Vitess"),
						...(database.region ? [heroChip(h, database.region)] : []),
						...(database.plan ? [heroChip(h, database.plan)] : []),
						heroChip(h, countLabel(database.branches.length, "branch", "branches")),
						...filterChipRail(h, model),
					],
	})
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: CHART_TOKENS }))],
		[
			h.submodel({
				slotId: "planetscale-db-tooltip",
				model: model.tooltip,
				view: Tooltip.view,
				toParentMessage: (message) => Message.GotTooltipMessage({ message }),
				viewInputs: {
					triggerIds: tooltipIds(model),
					toContent: (id) => tooltipContent(model, clock, id),
					// `ScopeChip`'s `TooltipContent className="max-w-[32ch]"`.
					className:
						model.tooltip.triggerId.startsWith("ps-chart-") ||
						model.tooltip.triggerId.startsWith("ps-insights-")
							? "max-w-[32ch]"
							: undefined,
					toView: ({ trigger, portal }) =>
						dashboardPage(
							h,
							{
								gap: "lg",
								filters: planetscaleSidebar(
									h,
									model,
									candidatesOf(model),
									filtersOf(model),
									AsyncData.isLoading(model.databases.data),
								),
								titleContent: hero.title,
								actions:
									heroActions.length === 0
										? branchSelect(h, model, timeControls)
										: h.div(
												[h.Class("flex flex-wrap items-center gap-2")],
												[...heroActions, branchSelect(h, model, timeControls)],
											),
								// TODO(alert-menu): see the note at the top of this file.
							},
							[hero.body, ...body(trigger), ...(portal === null ? [] : [portal])],
						),
				},
			}),
		],
	)
})
