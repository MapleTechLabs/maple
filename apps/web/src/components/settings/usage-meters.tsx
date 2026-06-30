import { Progress as ProgressPrimitive } from "@base-ui/react/progress"

import { FileIcon, PulseIcon, ChartLineIcon, ComputerIcon, type IconComponent } from "@/components/icons"
import type { AggregatedUsage } from "@/lib/billing/usage"
import { formatCount, formatUsage, usagePercentage } from "@/lib/billing/usage"
import type { PlanLimits } from "@/lib/billing/plans"
import { cn } from "@maple/ui/utils"

interface MeterRowProps {
	icon: IconComponent
	label: string
	used: number
	/** Plan cap for this meter. Pass `Infinity` for an uncapped meter; renders as "Unlimited". */
	limit: number
	formatValue: (value: number) => string
}

function MeterRow({ icon: Icon, label, used, limit, formatValue }: MeterRowProps) {
	const pct = usagePercentage(used, limit)
	const isUnlimited = limit === Infinity
	const limitLabel = isUnlimited ? "Unlimited" : formatValue(limit)
	// Every meter is metered with overage billing, so exceeding the included amount is a normal
	// billed state — not an error. The over branch stays on the brand amber, never `destructive`.
	const over = !isUnlimited && used > limit ? used - limit : 0
	const isOver = over > 0
	const level = pct > 100 ? "over" : pct > 80 ? "approaching" : "ok"
	const barClass = level === "approaching" ? "bg-severity-warn" : "bg-primary"
	const pctClass = level === "approaching" ? "text-severity-warn" : "text-muted-foreground"

	// In the over state the bar shows an honest included-vs-overage split, normalized to total
	// usage: a solid amber "included" segment and a translucent amber "overage" segment.
	const includedFraction = isOver ? (limit / used) * 100 : 0

	return (
		<ProgressPrimitive.Root value={Math.min(pct, 100)} className="flex flex-col gap-2">
			<div className="flex w-full items-center gap-2">
				<Icon size={14} className="text-muted-foreground shrink-0" />
				<ProgressPrimitive.Label className="text-xs font-medium">{label}</ProgressPrimitive.Label>
				<span className="text-muted-foreground ml-auto text-xs tabular-nums font-mono">
					{formatValue(used)} / {limitLabel}
				</span>
				{!isUnlimited &&
					(isOver ? (
						<span className="text-primary text-right text-xs tabular-nums font-mono">
							+{formatValue(over)}
						</span>
					) : (
						<span className={cn("w-10 text-right text-xs tabular-nums font-mono", pctClass)}>
							{Math.round(pct)}%
						</span>
					))}
			</div>
			<ProgressPrimitive.Track className="bg-muted h-1.5 relative flex w-full items-center overflow-x-hidden">
				{isOver ? (
					<>
						<div className="bg-primary h-full" style={{ width: `${includedFraction}%` }} />
						<div className="bg-background h-full w-px shrink-0" />
						<div className="bg-primary/30 h-full flex-1" />
					</>
				) : (
					<ProgressPrimitive.Indicator className={cn("h-full transition-all", barClass)} />
				)}
			</ProgressPrimitive.Track>
			{isOver && (
				<span className="text-muted-foreground text-[11px] tabular-nums">
					{formatValue(limit)} included · extra billed as overage
				</span>
			)}
		</ProgressPrimitive.Root>
	)
}

interface UsageMetersProps {
	usage: AggregatedUsage
	limits: PlanLimits
}

export function UsageMeters({ usage, limits }: UsageMetersProps) {
	return (
		<div className="space-y-4">
			<MeterRow
				icon={FileIcon}
				label="Logs"
				used={usage.logsGB}
				limit={limits.logsGB}
				formatValue={formatUsage}
			/>
			<MeterRow
				icon={PulseIcon}
				label="Traces"
				used={usage.tracesGB}
				limit={limits.tracesGB}
				formatValue={formatUsage}
			/>
			<MeterRow
				icon={ChartLineIcon}
				label="Metrics"
				used={usage.metricsGB}
				limit={limits.metricsGB}
				formatValue={formatUsage}
			/>
			<MeterRow
				icon={ComputerIcon}
				label="Browser Sessions"
				used={usage.browserSessions}
				limit={limits.browserSessions}
				formatValue={formatCount}
			/>
		</div>
	)
}
