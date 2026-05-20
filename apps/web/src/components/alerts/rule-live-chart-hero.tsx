import { useMemo } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import { cn } from "@maple/ui/utils"

import { AlertPreviewChart } from "@/components/alerts/alert-preview-chart"
import { AlertStatusBadge } from "@/components/alerts/alert-status-badge"
import { CheckIcon, EyeIcon, FireIcon, LoaderIcon, SquareTerminalIcon } from "@/components/icons"
import { computeBreachStats, formatBreachDuration, type BreachStats } from "@/lib/alerts/breach-stats"
import {
	formatSignalValue,
	signalLabels,
	type RuleFormState,
} from "@/lib/alerts/form-utils"

interface RuleLiveChartHeroProps {
	form: RuleFormState
	chartData: Record<string, unknown>[]
	chartLoading: boolean
	onTestRule: () => void
	testing: boolean
	previewResult: {
		status: "breached" | "healthy" | "skipped"
		value: number | null
	} | null
}

/**
 * Hero block sitting above the form: a live chart of the rule's signal over
 * the last 24h with the threshold line drawn in. The "would-have-fired"
 * status is folded into the header strip as a compact pill so the entire
 * hero stays inside one short card. For raw-SQL rules — where there's no
 * structured preview — the chart is replaced with a hint pointing the user
 * at the Test rule button instead.
 */
export function RuleLiveChartHero({
	form,
	chartData,
	chartLoading,
	onTestRule,
	testing,
	previewResult,
}: RuleLiveChartHeroProps) {
	const threshold = Number(form.threshold)
	const thresholdUpper =
		form.thresholdUpper.trim().length > 0 && Number.isFinite(Number(form.thresholdUpper))
			? Number(form.thresholdUpper)
			: null

	const stats = useMemo(
		() => computeBreachStats(chartData, threshold, form.comparator, thresholdUpper),
		[chartData, threshold, form.comparator, thresholdUpper],
	)

	const isRawQuery = form.signalType === "raw_query"
	const safeThreshold = Number.isFinite(threshold) ? threshold : 0

	return (
		<Card className="overflow-hidden">
			<div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
				<div className="flex min-w-0 items-center gap-2">
					<Badge variant="outline" className="font-mono text-xs">
						{signalLabels[form.signalType]}
					</Badge>
					<span className="text-muted-foreground text-xs">Live · last 24h</span>
					{!isRawQuery && <BreachPill stats={stats} />}
				</div>
				<div className="flex items-center gap-2">
					{previewResult && (
						<PreviewBadge
							status={previewResult.status}
							value={previewResult.value}
							signalType={form.signalType}
						/>
					)}
					<Button
						variant="outline"
						size="sm"
						onClick={onTestRule}
						disabled={testing}
					>
						{testing ? (
							<LoaderIcon size={14} className="animate-spin" />
						) : (
							<EyeIcon size={14} />
						)}
						Test rule
					</Button>
				</div>
			</div>

			<div className="px-4 pb-4">
				{isRawQuery ? (
					<RawQueryPreviewPlaceholder />
				) : (
					<AlertPreviewChart
						data={chartData}
						threshold={safeThreshold}
						signalType={form.signalType}
						loading={chartLoading}
						className="h-[220px] w-full"
					/>
				)}
			</div>
		</Card>
	)
}

function BreachPill({ stats }: { stats: BreachStats }) {
	if (stats.bucketCount === 0) return null
	if (stats.breachCount === 0) {
		return (
			<span className="hidden items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 sm:inline-flex">
				<CheckIcon size={12} />
				No breaches in 24h
			</span>
		)
	}
	return (
		<span className="hidden items-center gap-1 text-xs text-destructive sm:inline-flex">
			<FireIcon size={12} />
			Fired{" "}
			<span className="font-mono font-semibold tabular-nums">{stats.breachCount}×</span>
			{stats.longestRunMs !== null && stats.longestRunBuckets > 1 && (
				<>
					{" "}· longest{" "}
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
		return (
			<span className="text-muted-foreground text-xs">
				Skipped · insufficient samples
			</span>
		)
	}
	return (
		<div className="flex items-center gap-2">
			<span
				className={cn(
					"font-mono text-sm font-semibold tabular-nums",
					status === "breached" ? "text-destructive" : "text-emerald-500",
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

function RawQueryPreviewPlaceholder() {
	return (
		<div className="flex h-[220px] w-full items-center justify-center rounded-md border border-dashed bg-muted/20 px-6 text-center">
			<div className="max-w-sm space-y-2">
				<div className="mx-auto flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
					<SquareTerminalIcon size={16} />
				</div>
				<p className="font-medium text-sm">Live preview unavailable for raw SQL</p>
				<p className="text-muted-foreground text-xs">
					Use <span className="font-medium">Test rule</span> to execute the SQL
					and see the resulting value.
				</p>
			</div>
		</div>
	)
}
