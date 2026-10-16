import { conditionSubject } from "@/components/alerts/rule-condition-bar"
import { useMemo, type ReactNode } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

import type { AlertRulePreviewResponse } from "@maple/domain/http"
import { AlertRuleChart } from "@/components/alerts/alert-rule-chart"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { RuleEditImpact } from "@/components/alerts/rule-edit-impact"
import { CheckIcon, CircleWarningIcon, EyeIcon, FireIcon } from "@/components/icons"
import { breachStatsFromPreview, formatBreachDuration, type BreachStats } from "@/lib/alerts/breach-stats"
import {
	countSkippedWindows,
	draftThresholds,
	focusPreviewOnClosestGroups,
	type RuleFieldChange,
	type SkippedWindows,
} from "@/lib/alerts/preview-insights"
import { normalizeTimestampInput } from "@/lib/timezone-format"
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker"
import type { TimeRange } from "@/components/time-range-picker/types"
import type { AlertIncidentDocument } from "@maple/domain/http"
import {
	displaySignalType,
	formatSignalValue,
	type RuleFormState,
} from "@/lib/alerts/form-utils"

interface RuleLiveChartHeroProps {
	form: RuleFormState
	/** Evaluator-faithful preview from `useAlertRulePreview`. */
	preview: AlertRulePreviewResponse | null
	previewLoading: boolean
	previewError: string | null
	onTestRule: () => void
	testing: boolean
	previewResult: {
		status: "breached" | "healthy" | "skipped"
		value: number | null
	} | null
	/** Resolved absolute window the preview was evaluated over. */
	range: { startTime: string; endTime: string }
	/** The picker's own (unresolved) selection — preset or custom bounds. */
	timeRange: TimeRange
	onTimeRangeChange: (range: TimeRange) => void
	/** Edit mode: the saved rule's replay and what the edit changes, drawn above the chart. */
	comparison?: {
		savedPreview: AlertRulePreviewResponse | null
		savedLoading: boolean
		changes: readonly RuleFieldChange[]
		clearedIncidents: readonly AlertIncidentDocument[]
	} | null
	/** The condition bar, docked under the chart it redraws. */
	children?: ReactNode
}

/**
 * The editor's preview: the same chart the rule detail page renders, fed by
 * the evaluator's own replay over a user-picked lookback, with the threshold
 * line, would-fire bands and the verdict. The condition bar docks under it, and
 * edit mode adds the saved-vs-draft replay above it.
 */
export function RuleLiveChartHero({
	form,
	preview,
	previewLoading,
	previewError,
	onTestRule,
	testing,
	previewResult,
	range,
	timeRange,
	onTimeRangeChange,
	comparison = null,
	children,
}: RuleLiveChartHeroProps) {
	// The preview plots domain units (error rate as a 0–1 ratio); the form's
	// threshold goes through the same conversion the save does.
	const { threshold, upper: thresholdUpper } = draftThresholds(form)
	const displaySignal = displaySignalType(form)

	// The chart's domain is the exact window the preview query ran over, so the
	// axis, threshold line, and would-fire bands stay in step with the picker.
	const window = useMemo(
		() => ({
			min: new Date(normalizeTimestampInput(range.startTime)).getTime(),
			max: new Date(normalizeTimestampInput(range.endTime)).getTime(),
		}),
		[range.startTime, range.endTime],
	)

	const stats = useMemo(() => breachStatsFromPreview(preview), [preview])
	const skipped = useMemo(() => countSkippedWindows(preview), [preview])
	// A split rule draws only the groups nearest to firing; the verdict still counts them all.
	const focused = useMemo(() => focusPreviewOnClosestGroups(preview), [preview])
	const groupBySummary = formatGroupBySummary(form)

	return (
		<Card className="gap-0 overflow-hidden p-0">
			<div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-2">
				<div className="flex min-w-0 items-center gap-2">
					<Badge variant="outline" className="font-mono text-xs">
						{conditionSubject(form)}
					</Badge>
					{groupBySummary && (
						<span className="hidden max-w-[360px] truncate text-muted-foreground text-xs md:inline">
							per {groupBySummary}
						</span>
					)}
					<BreachPill stats={stats} />
				</div>
				{/* shrink-0: a custom range's long label must squeeze the left-hand
				    summary, not the controls. */}
				<div className="flex shrink-0 items-center gap-2">
					{previewResult && (
						<PreviewBadge
							status={previewResult.status}
							value={previewResult.value}
							signalType={displaySignal}
						/>
					)}
					{/* Preview-only lookback: it re-runs the preview query, never the
					    rule being saved. */}
					<TimeRangePicker
						startTime={timeRange.startTime}
						endTime={timeRange.endTime}
						presetValue={timeRange.presetValue}
						onChange={onTimeRangeChange}
					/>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button variant="outline" size="sm" onClick={onTestRule} loading={testing} />
							}
						>
							<EyeIcon size={14} />
							Dry run
						</TooltipTrigger>
						<TooltipContent>
							Evaluate the rule once against current data. Nothing is sent.
						</TooltipContent>
					</Tooltip>
				</div>
			</div>

			{comparison !== null && (
				<RuleEditImpact
					{...comparison}
					draftPreview={preview}
					draftLoading={previewLoading}
					form={form}
					domain={window}
				/>
			)}

			<div className="space-y-2 px-4 pt-3 pb-4">
				<AlertRuleChart
					preview={focused.preview}
					showWouldFire
					threshold={threshold}
					thresholdUpper={thresholdUpper}
					comparator={form.comparator}
					signalType={displaySignal}
					window={window}
					loading={previewLoading}
					error={previewError}
				/>
				{focused.hiddenGroupCount > 0 && (
					<p className="text-2xs text-muted-foreground">
						Showing the {focused.shownGroups.length} groups closest to the threshold ·{" "}
						{focused.hiddenGroupCount} more
					</p>
				)}
				<SkippedWindowsWarning skipped={skipped} form={form} />
			</div>

			{children && <div className="border-t bg-muted/20 px-4 py-3">{children}</div>}
		</Card>
	)
}

/**
 * Said while editing, not after saving: windows the evaluator would skip can
 * never fire, so a rule that skips most of them is quieter than it looks.
 */
function SkippedWindowsWarning({ skipped, form }: { skipped: SkippedWindows; form: RuleFormState }) {
	if (skipped.skipped === 0) return null
	const share = skipped.skipped / Math.max(skipped.total, 1)
	const reasons = [
		skipped.byReason.below_min_samples > 0 &&
			`${skipped.byReason.below_min_samples} under ${form.minimumSampleCount} samples`,
		skipped.byReason.no_data > 0 && `${skipped.byReason.no_data} with no data`,
		skipped.byReason.no_value > 0 && `${skipped.byReason.no_value} with no value`,
	].filter((reason): reason is string => reason !== false)
	const advice =
		skipped.byReason.below_min_samples >= skipped.byReason.no_data
			? "Lower Min samples so they count."
			: form.alertOnNoData
				? null
				: "Turn on alerting when there is no data to count them."
	return (
		<div
			className={cn(
				"flex items-start gap-2 text-xs",
				share >= 0.25 ? "text-severity-warn" : "text-muted-foreground",
			)}
		>
			<CircleWarningIcon size={14} className="mt-px shrink-0" />
			<span>
				{skipped.skipped} of {skipped.total} windows would be skipped ({reasons.join(", ")}), and a
				skipped window can't fire.{advice && ` ${advice}`}
			</span>
		</div>
	)
}

function formatGroupBySummary(form: RuleFormState): string | null {
	const groupBy =
		form.signalType === "builder_query" && form.queryBuilderDraft.addOns?.groupBy
			? (form.queryBuilderDraft.groupBy ?? [])
			: form.groupBy
	const visible = groupBy.filter((value) => value !== "none")
	if (visible.length === 0) return null
	return visible.join(", ")
}

function BreachPill({ stats }: { stats: BreachStats }) {
	if (stats.bucketCount === 0) return null
	if (stats.breachCount === 0) {
		return (
			<span className="hidden items-center gap-1 text-xs text-severity-info sm:inline-flex">
				<CheckIcon size={12} />
				No breaches in this window
			</span>
		)
	}
	return (
		<span className="hidden items-center gap-1 text-xs text-severity-error sm:inline-flex">
			<FireIcon size={12} />
			Would have fired{" "}
			<span className="font-mono font-semibold tabular-nums">{stats.breachCount}×</span>
			{stats.longestRunMs !== null && (
				<>
					{" "}
					· longest{" "}
					<span className="font-mono font-semibold tabular-nums">
						{formatBreachDuration(stats.longestRunMs)}
					</span>
				</>
			)}
		</span>
	)
}

function PreviewBadge({
	status,
	value,
	signalType,
}: {
	status: "breached" | "healthy" | "skipped"
	value: number | null
	signalType: RuleFormState["signalType"]
}) {
	if (status === "skipped") {
		return <span className="text-muted-foreground text-xs">Skipped · insufficient samples</span>
	}
	return (
		<div className="flex items-center gap-2">
			<span
				className={cn(
					"font-mono text-sm font-semibold tabular-nums",
					status === "breached" ? "text-severity-error" : "text-severity-info",
				)}
			>
				{formatSignalValue(signalType, value)}
			</span>
			<AlertStatusBadge
				state={status === "breached" ? "firing" : "ok"}
				label={status === "breached" ? "Would trigger" : "Within threshold"}
			/>
		</div>
	)
}
