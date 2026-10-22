import {
	breachStatsFromPreview,
	type BreachStats,
	formatBreachDuration,
} from "@maple/web-data/alerts/breach-stats"
import { displaySignalType, formatSignalValue } from "@maple/web-data/alerts/form-utils"
import {
	countSkippedWindows,
	draftThresholds,
	focusPreviewOnClosestGroups,
} from "@maple/web-data/alerts/preview-insights"
import { cn } from "@maple/ui/lib/utils"
import { Struct } from "effect"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import { button } from "../../../ui/button"
import { card } from "../../../ui/card"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { stableSlice } from "../../kit/stable-slice"
import { presetLabel } from "../../kit/time-controls"
import { alertStatusBadge } from "../shared/badges"
import { previewStateOf } from "../shared/preview"
import { ruleChart } from "../shared/rule-chart"
import { conditionSubject, groupBySummary, previewIdentityKey } from "./derive"
import { draftPreviewOf, windowMsOf } from "./derive-rows"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { DryRun, Model } from "./model"
import { editImpact, type ImpactView } from "./view-impact"

// `RuleLiveChartHero`: the evaluator's replay of the
// draft with the threshold, would-fire bands and the dry-run verdict.

type H = HtmlBuilder<Message>

const breachPill = (h: H, stats: BreachStats): ReadonlyArray<Html> => {
	if (stats.bucketCount === 0) return []
	if (stats.breachCount === 0)
		return [
			h.span(
				[h.Class("hidden items-center gap-1 text-xs text-severity-info sm:inline-flex")],
				[icon(h, "CheckIcon", { size: 12 }), "No breaches in this window"],
			),
		]
	return [
		h.span(
			[h.Class("hidden items-center gap-1 text-xs text-severity-error sm:inline-flex")],
			[
				icon(h, "FireIcon", { size: 12 }),
				"Would have fired",
				" ",
				h.span([h.Class("font-mono font-semibold tabular-nums")], [String(stats.breachCount), "×"]),
				...(stats.longestRunMs === null
					? []
					: [
							" ",
							"· longest",
							" ",
							h.span(
								[h.Class("font-mono font-semibold tabular-nums")],
								[formatBreachDuration(stats.longestRunMs)],
							),
						]),
			],
		),
	]
}

/** `PreviewBadge`: the dry run's value and verdict. */
const dryRunBadge = (h: H, dryRun: DryRun, form: RuleForm): Html => {
	if (dryRun.status === "skipped")
		return h.span([h.Class("text-muted-foreground text-xs")], ["Skipped · insufficient samples"])
	const isBreached = dryRun.status === "breached"
	return h.div(
		[h.Class("flex items-center gap-2")],
		[
			h.span(
				[
					h.Class(
						cn(
							"font-mono text-sm font-semibold tabular-nums",
							isBreached ? "text-severity-error" : "text-severity-info",
						),
					),
				],
				[formatSignalValue(displaySignalType(form), dryRun.value)],
			),
			alertStatusBadge(h, isBreached ? "firing" : "ok", {
				label: isBreached ? "Would trigger" : "Within threshold",
			}),
		],
	)
}

/** The card's header: the condition, the replay's breaches, the dry run and the range picker. */
type HeaderView = Pick<
	Model,
	"preview" | "previewWindow" | "dryRun" | "timePicker" | "previewPreset" | "isDryRunning"
>

const header = (h: H, model: HeaderView, form: RuleForm, timeZone: string): Html => {
	const stats = breachStatsFromPreview(draftPreviewOf(model, form).preview)
	const summary = groupBySummary(form)
	const dryRun =
		model.dryRun !== null && model.dryRun.key === previewIdentityKey(form) ? model.dryRun : null
	return h.div(
		[h.Class("flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2")],
		[
			h.div(
				[h.Class("flex min-w-0 items-center gap-2")],
				[
					badge(h, { variant: "outline", className: "font-mono text-xs" }, [
						conditionSubject(form),
					]),
					...(summary === null
						? []
						: [
								h.span(
									[
										h.Class(
											"hidden max-w-[360px] truncate text-muted-foreground text-xs md:inline",
										),
									],
									["per ", summary],
								),
							]),
					...breachPill(h, stats),
				],
			),
			h.div(
				[h.Class("flex shrink-0 items-center gap-2")],
				[
					...(dryRun === null ? [] : [dryRunBadge(h, dryRun, form)]),
					h.submodel({
						slotId: "alert-rule-preview-range",
						model: model.timePicker,
						view: TimeRangePicker.view,
						toParentMessage: (message) => Message.GotTimePickerMessage({ message }),
						viewInputs: {
							label: presetLabel(model.previewPreset),
							selectedPreset: model.previewPreset,
							presets: TimeRangePicker.PRESET_VALUES,
							timeZone,
							hasHotkey: false,
						},
					}),
					// TODO(alert-editor): the "Evaluate the rule once…" tooltip.
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							isLoading: model.isDryRunning,
							attributes: [h.OnClick(Message.ClickedDryRun())],
						},
						[icon(h, "EyeIcon", { size: 14 }), "Dry run"],
					),
				],
			),
		],
	)
}

/** The chart with the threshold and would-fire bands, and the notes under it. */
type ChartView = Pick<Model, "preview" | "previewWindow" | "chart" | "themeColors" | "chartRuntime">

const chartBody = (h: H, model: ChartView, form: RuleForm, timeZone: string): Html => {
	const preview = draftPreviewOf(model, form)
	const thresholds = draftThresholds(form)
	const focused = focusPreviewOnClosestGroups(preview.preview)
	const isChartReady = model.themeColors !== null && isChartRuntimeReady(model.chartRuntime)
	return h.div(
		[h.Class("space-y-2 px-4 pt-3 pb-4")],
		[
			ruleChart(h, {
				chartId: "alert-rule-editor-chart",
				chart: model.chart,
				toChartMessage: (message) => Message.GotChartMessage({ message }),
				colors: model.themeColors ?? {},
				timeZone,
				preview: focused.preview,
				showWouldFire: true,
				threshold: thresholds.threshold,
				thresholdUpper: thresholds.upper,
				criticalThreshold: thresholds.critical,
				comparator: form.comparator,
				signalType: displaySignalType(form),
				window: windowMsOf(model),
				isLoading: preview.isLoading || !isChartReady,
				error: preview.error,
			}),
			...(focused.hiddenGroupCount > 0
				? [
						h.p(
							[h.Class("text-2xs text-muted-foreground")],
							[
								"Showing the ",
								String(focused.shownGroups.length),
								" groups closest to the threshold ·",
								" ",
								String(focused.hiddenGroupCount),
								" more",
							],
						),
					]
				: []),
			...skippedWarning(h, model.preview, form),
		],
	)
}

// Each part is rebuilt only when what it reads changes; `evaluated` skips name, tag and destination edits.
const headerSlot = createLazy()
const impactSlot = createLazy()
const chartSlot = createLazy()
const headerOf = stableSlice((model: Model): HeaderView =>
	Struct.pick(model, ["preview", "previewWindow", "dryRun", "timePicker", "previewPreset", "isDryRunning"]),
)
const impactOf = stableSlice((model: Model): ImpactView =>
	Struct.pick(model, [
		"savedForm",
		"savedPreview",
		"preview",
		"previewWindow",
		"incidents",
		"editingRuleId",
	]),
)
const chartOf = stableSlice((model: Model): ChartView =>
	Struct.pick(model, ["preview", "previewWindow", "chart", "themeColors", "chartRuntime"]),
)

/** Step 2's chart card; the comparison block joins it while editing with unsaved changes. */
export const liveChartHero = (
	h: H,
	model: Model,
	form: RuleForm,
	evaluated: RuleForm,
	timeZone: string,
): Html => {
	const impact = impactSlot(editImpact, [h, impactOf(model), form])
	return card(
		h,
		[
			headerSlot(header, [h, headerOf(model), evaluated, timeZone]),
			...(impact === null ? [] : [impact]),
			chartSlot(chartBody, [h, chartOf(model), evaluated, timeZone]),
		],
		"gap-0 overflow-hidden p-0",
	)
}

/** `SkippedWindowsWarning`: windows the evaluator would skip can never fire. */
const skippedWarning = (h: H, slot: Model["preview"], form: RuleForm): ReadonlyArray<Html> => {
	const preview = previewStateOf(slot, true, null).preview
	const skipped = countSkippedWindows(preview)
	if (skipped.skipped === 0) return []
	const share = skipped.skipped / Math.max(skipped.total, 1)
	const reasons = [
		skipped.byReason.below_min_samples > 0
			? `${skipped.byReason.below_min_samples} under ${form.minimumSampleCount} samples`
			: null,
		skipped.byReason.no_data > 0 ? `${skipped.byReason.no_data} with no data` : null,
		skipped.byReason.no_value > 0 ? `${skipped.byReason.no_value} with no value` : null,
	].filter((reason): reason is string => reason !== null)
	const advice =
		skipped.byReason.below_min_samples >= skipped.byReason.no_data
			? "Lower Min samples so they count."
			: form.alertOnNoData
				? null
				: "Turn on alerting when there is no data to count them."
	return [
		h.div(
			[
				h.Class(
					cn(
						"flex items-start gap-2 text-xs",
						share >= 0.25 ? "text-severity-warn" : "text-muted-foreground",
					),
				),
			],
			[
				icon(h, "CircleWarningIcon", { size: 14, className: "mt-px shrink-0" }),
				h.span(
					[],
					[
						String(skipped.skipped),
						" of ",
						String(skipped.total),
						" windows would be skipped (",
						reasons.join(", "),
						"), and a skipped window can't fire.",
						...(advice === null ? [] : [` ${advice}`]),
					],
				),
			],
		),
	]
}
