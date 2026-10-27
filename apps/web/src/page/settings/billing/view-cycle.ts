import { formatCurrency } from "@maple/domain/format"
import type { DailySpendResponse } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import type { TrialStatus } from "../../../lib/billing/plan-gating"
import { sentenceCasePlanName } from "../../../lib/billing/plans"
import {
	buildCumulativeSeries,
	costBreakdown,
	FEATURE_COLORS,
	FEATURE_LABELS,
	SPEND_FEATURES,
	type SpendModel,
} from "../../../lib/billing/spend"
import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import type { ChartSpec } from "../../../charts/chart-spec"
import { bucketTooltipBody } from "../../../charts/bucket-tooltip"
import { plotFrame } from "../../../charts/plot-frame"
import { resolveColor, ResolveThemeColors, type ThemeColors } from "../../../charts/theme-colors"
import { chartEmpty, chartLoading } from "../../../ui/chart-state"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { statFigure } from "../../../ui/stat-figure"
import { seriesLegend } from "../../kit/series-legend"
import { Message, type Model } from "./model"

type H = HtmlBuilder<Message>

// `BillingCyclePanel`, `SpendChart` and `CostBreakdown` (apps/web/src/components/settings/).

const dollars = (cents: number, currency: string) => formatCurrency(cents / 100, currency)

/** The plot itself; the states around it reserve the legend strip too. */
const CHART_HEIGHT = 150
const SPEND_CHART_HEIGHT = 190

const BASE_COLOR = "#57534a"
const BANDS = ["base", ...SPEND_FEATURES] as const
/** The base band carries every fixed fee, so it names the add-ons when there are any. */
const bandLabel = (band: (typeof BANDS)[number], spend: SpendModel) =>
	band === "base" ? (spend.addOns.length > 0 ? "Plan + add-ons" : "Base plan") : FEATURE_LABELS[band]
const bandColor = (band: (typeof BANDS)[number]) => (band === "base" ? BASE_COLOR : FEATURE_COLORS[band])

/** The custom properties the plot reads: the projection's primary and the chrome. */
export const SPEND_THEME_TOKENS = ["--primary", "--border", "--background"]

const figure = (
	h: H,
	options: Readonly<{
		label: string
		value: string
		note: ReadonlyArray<Html | string>
		valueClassName?: string
	}>,
): Html =>
	h.div(
		[h.Class("flex min-w-0 flex-col gap-2 p-4")],
		[
			// The uppercase overline every KPI tile uses (Overview's usage cards, the Stat widget).
			eyebrow(h, {}, [options.label]),
			statFigure(h, { size: "lg", value: options.value, valueClassName: options.valueClassName }),
			h.span([h.Class("font-prose text-2xs text-muted-foreground")], options.note),
		],
	)

export const cyclePanelSkeleton = (h: H): Html =>
	panel(h, {}, [
		h.div(
			[h.Class("flex items-center justify-between border-b px-4 py-3")],
			[skeleton(h, "h-4 w-28"), skeleton(h, "h-3.5 w-44")],
		),
		h.div(
			[h.Class("grid grid-cols-1 border-b sm:grid-cols-3")],
			[0, 1, 2].map((index) =>
				h.div(
					[h.Key(String(index)), h.Class("flex flex-col gap-2 p-4")],
					[skeleton(h, "h-2.5 w-16"), skeleton(h, "h-6 w-24"), skeleton(h, "h-2.5 w-28")],
				),
			),
		),
		skeleton(h, "m-4 h-40"),
	])

type PlotInputs = Readonly<{ spec: ChartSpec }>

/** `CursorPlot` with `ariaLabel="Cumulative spend this cycle"`. */
const spendPlot = Submodel.defineView<Chart.Model, Chart.Message, PlotInputs>((model, inputs, h) =>
	plotFrame(h, {
		chartId: "billing-spend",
		spec: inputs.spec,
		ariaLabel: "Cumulative spend this cycle",
		className: "h-full w-full",
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				tooltip._tag === "Bucket"
					? Option.some(bucketTooltipBody(h, tooltip, portal))
					: Option.none(),
			),
	}),
)

const spendChart = (h: H, model: Model, spend: SpendModel, daily: DailySpendResponse): Html => {
	const data = buildCumulativeSeries({ daily, model: spend })
	if (data.length === 0)
		return chartEmpty(h, { height: SPEND_CHART_HEIGHT }, ["No ingest recorded this cycle yet"])
	const colors: ThemeColors = model.themeColors ?? {}
	const primary = resolveColor(colors, "--primary")
	const projected = spend.projectedCents / 100
	const peak = Math.max(projected, ...data.map((point) => point.total ?? 0), 1)
	const yMax = Math.ceil((peak * 1.1) / 10) * 10
	const latest = data.findLast((point) => !point.future)
	const lastPoint = data[data.length - 1]
	const hasFuture = lastPoint !== undefined && lastPoint.future
	const spec: ChartSpec = {
		_tag: "SpendCumulative",
		points: data.map((point) => ({
			date: point.date,
			dayMs: point.dayMs,
			bands: Object.fromEntries(BANDS.map((band) => [band, point[band]])),
			projected: point.projected,
			future: point.future,
		})),
		bands: BANDS.map((band) => ({ key: band, label: bandLabel(band, spend), color: bandColor(band) })),
		primary,
		chrome: {
			border: resolveColor(colors, "--border"),
			background: resolveColor(colors, "--background"),
		},
		projected,
		yMax,
		currency: spend.currency,
	}
	return h.div(
		[h.Class("flex flex-col")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pt-3")],
				[
					h.span(
						[h.Class("text-2xs font-medium text-muted-foreground")],
						["Cumulative spend by feature"],
					),
					// Colors only: the amounts live in the figures and the cost breakdown.
					seriesLegend(h, {
						className: "gap-x-4",
						items: [
							...BANDS.filter((band) => (latest?.[band] ?? 0) > 0).map((band) => ({
								key: band,
								label: bandLabel(band, spend),
								color: bandColor(band),
							})),
							...(hasFuture
								? [
										{
											key: "projected",
											label: "Projection",
											color: primary,
											swatch: "dashed" as const,
										},
									]
								: []),
						],
					}),
				],
			),
			h.div(
				[h.Class("px-2 pt-3 pb-2"), h.OnMount(ResolveThemeColors({ tokens: SPEND_THEME_TOKENS }))],
				[
					h.div(
						[h.Class("w-full"), h.Style({ height: `${CHART_HEIGHT}px` })],
						[
							h.submodel({
								slotId: "billing-spend-plot",
								model: model.chart,
								view: spendPlot,
								toParentMessage: (message) => Message.GotChartMessage({ message }),
								viewInputs: { spec },
							}),
						],
					),
				],
			),
		],
	)
}

const chartSlot = (h: H, model: Model, spend: SpendModel): Html => {
	const daily = model.daily
	switch (daily._tag) {
		case "Idle":
		case "Loading":
			return chartLoading(h, { variant: "area", height: SPEND_CHART_HEIGHT })
		case "Failure":
			// A section of the cycle panel: the compact row, so the breakdown stays above the fold.
			return errorState(h, {
				failure: daily.error,
				title: "Couldn't load daily spend",
				variant: "row",
				onRetry: Message.ClickedRetryDaily(),
				className: "rounded-none border-0 px-4 py-3",
			})
		case "Success":
		case "Refreshing":
		case "Stale":
			return spendChart(h, model, spend, daily.data)
	}
}

/** What makes up "Spent so far": the plan, each add-on and one usage overage line. */
const costBreakdownView = (h: H, model: Model, spend: SpendModel): Html => {
	const isOpen = model.isBreakdownOpen
	return h.div(
		[h.DataAttribute(isOpen ? "open" : "closed", ""), h.DataAttribute("slot", "collapsible")],
		[
			h.button(
				[
					...(isOpen ? [h.AriaControls("billing-cost-breakdown")] : []),
					h.AriaDisabled(false),
					h.AriaExpanded(isOpen),
					h.Class(
						"group flex w-full items-center gap-2 px-4 py-2.5 text-left outline-none focus-visible:bg-muted/40",
					),
					...(isOpen ? [h.DataAttribute("panel-open", "")] : []),
					h.DataAttribute("slot", "collapsible-trigger"),
					h.Tabindex(0),
					h.Type("button"),
					h.OnClick(Message.ToggledBreakdown()),
				],
				[
					icon(h, "ChevronRightIcon", {
						className:
							"size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none",
						attributes: [h.AriaHidden(true)],
					}),
					h.span([h.Class("text-xs font-medium")], ["Cost breakdown"]),
					h.span(
						[h.Class("truncate font-prose text-2xs text-muted-foreground")],
						["What makes up the amount spent so far"],
					),
				],
			),
			...(isOpen
				? [
						h.div(
							[
								h.Class(cn(collapsiblePanelStyles, "px-4 pb-2")),
								h.DataAttribute("open", ""),
								h.DataAttribute("slot", "collapsible-panel"),
								h.Id("billing-cost-breakdown"),
								h.Style({
									"--collapsible-panel-height": "auto",
									"--collapsible-panel-width": "auto",
									"animation-name": "none",
								}),
							],
							[
								h.div(
									[h.Class("divide-y divide-border/60")],
									costBreakdown(spend).map((line) =>
										h.div(
											[
												h.Key(line.key),
												h.Class("flex items-baseline justify-between gap-4 py-2"),
											],
											[
												h.div(
													[h.Class("min-w-0")],
													[
														h.p([h.Class("text-sm")], [line.label]),
														h.p(
															[
																h.Class(
																	"font-prose text-2xs text-muted-foreground",
																),
															],
															[line.detail],
														),
													],
												),
												h.span(
													[h.Class("shrink-0 font-mono text-sm tabular-nums")],
													[
														line.cents === null
															? "Not itemized"
															: dollars(line.cents, spend.currency),
													],
												),
											],
										),
									),
								),
								...(spend.partial
									? [
											h.p(
												[h.Class("pt-1 text-2xs text-muted-foreground")],
												[
													"Some items are on pricing we can't itemize; your invoice has the exact amount.",
												],
											),
										]
									: []),
							],
						),
					]
				: []),
		],
	)
}

export type CyclePanelInputs = Readonly<{
	spend: SpendModel
	trial: TrialStatus
	isLegacy: boolean
	maximumInvoiceCents: number | null
	uncappedCount: number
	timeZone: string
}>

/** This cycle in one panel: plan and period, the three figures, the chart and the breakdown. */
export const cyclePanel = (h: H, model: Model, inputs: CyclePanelInputs): Html => {
	const { spend, trial, timeZone } = inputs
	const period = `${formatDateInTimezone(new Date(spend.cycle.startMs), { timeZone, withYear: false })} – ${formatDateInTimezone(new Date(spend.cycle.endMs), { timeZone })}`
	const isTrialing = trial.isTrialing && trial.daysRemaining !== null
	const maximum = inputs.maximumInvoiceCents
	return panel(h, { className: "overflow-hidden" }, [
		h.div(
			[h.Class("flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3")],
			[
				h.div(
					[h.Class("flex items-center gap-2")],
					[
						h.span(
							[h.Class("text-sm font-medium")],
							[spend.planName === null ? "No plan" : sentenceCasePlanName(spend.planName)],
						),
						...(trial.planStatus === null
							? []
							: [
									badge(h, { size: "sm", variant: isTrialing ? "warn" : "ok" }, [
										isTrialing ? `Trial, ${trial.daysRemaining}d left` : "Active",
									]),
								]),
						...(inputs.isLegacy ? [badge(h, { size: "sm", variant: "warn" }, ["Legacy"])] : []),
					],
				),
				h.div(
					[h.Class("flex items-center gap-2 text-xs tabular-nums")],
					[
						h.span([], [period]),
						h.span([h.Class("text-muted-foreground")], ["·"]),
						h.span(
							[h.Class("text-muted-foreground")],
							["Day ", String(spend.dayOfCycle), " of ", String(spend.cycleDays)],
						),
					],
				),
			],
		),
		h.div(
			[h.Class("grid grid-cols-1 divide-y border-b sm:grid-cols-3 sm:divide-x sm:divide-y-0")],
			[
				figure(h, {
					label: "Spent so far",
					value: dollars(spend.spendCents, spend.currency),
					note: [
						spend.partial ? "At least; some items aren't itemized" : "Excludes taxes and credits",
					],
				}),
				figure(h, {
					label: "Projected",
					value: dollars(spend.projectedCents, spend.currency),
					// Neutral unless the cycle is heading past the plan's fixed fees or the overage caps.
					valueClassName:
						(spend.baseCents > 0 && spend.projectedCents > spend.baseCents) ||
						(maximum !== null && spend.projectedCents > maximum)
							? "text-warning"
							: undefined,
					note: ["At this cycle's daily rate"],
				}),
				figure(h, {
					label: "Maximum invoice",
					value: maximum === null ? "Uncapped" : dollars(maximum, spend.currency),
					note:
						maximum !== null
							? ["Base plan plus every overage cap"]
							: inputs.uncappedCount === 0
								? ["Some items can't be priced"]
								: [
										h.span(
											[h.Class("flex flex-wrap items-center gap-x-1.5")],
											[
												inputs.uncappedCount === 1
													? "1 feature has no cap"
													: `${inputs.uncappedCount} features have no cap`,
												...(model.isAdmin
													? [
															h.button(
																[
																	h.Class(
																		"font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50",
																	),
																	...(model.isSavingCap
																		? [h.Disabled(true)]
																		: []),
																	h.Type("button"),
																	h.OnClick(Message.ClickedSetCaps()),
																],
																["Set caps"],
															),
														]
													: []),
											],
										),
									],
				}),
			],
		),
		h.div([h.Class("border-b")], [chartSlot(h, model, spend)]),
		costBreakdownView(h, model, spend),
		...(isTrialing && trial.trialEndsAt !== null
			? [
					h.p(
						[h.Class("border-t px-4 py-2.5 text-2xs text-muted-foreground")],
						[
							"Your card is charged when the trial ends on ",
							formatDateInTimezone(trial.trialEndsAt, { timeZone, withYear: false }),
							". Cancel before then to avoid charges.",
						],
					),
				]
			: []),
	])
}
