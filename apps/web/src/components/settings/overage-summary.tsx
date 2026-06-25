import type { OverageSummary as OverageSummaryData } from "@/lib/billing/plan-gating"
import { formatCount, formatCurrency, formatRate, formatUsage } from "@/lib/billing/usage"

// Display label + unit formatter per metered featureId. GB for the ingest trio,
// raw counts for browser sessions.
const FEATURE_DISPLAY: Record<string, { label: string; formatUnits: (value: number) => string }> = {
	logs: { label: "Logs", formatUnits: formatUsage },
	traces: { label: "Traces", formatUnits: formatUsage },
	metrics: { label: "Metrics", formatUnits: formatUsage },
	browser_sessions: { label: "Browser Sessions", formatUnits: formatCount },
}

/**
 * Estimated overage charges accruing this billing period, broken down per
 * feature. Renders nothing unless the org is over an included grant — usage
 * within plan never shows a cost. Prices are pulled live from the plan, so this
 * is an estimate of charges-so-far, not a final invoice.
 */
export function OverageSummary({ summary }: { summary: OverageSummaryData }) {
	if (!summary.hasOverage) return null

	return (
		<div className="mt-6 rounded-md border border-border/60 bg-muted/30 p-4">
			<div className="flex items-baseline justify-between gap-4">
				<span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
					Estimated overage this period
				</span>
				<span className="text-sm font-semibold tabular-nums text-primary">
					{formatCurrency(summary.total)}
				</span>
			</div>
			<div className="mt-3 space-y-1.5">
				{summary.features.map((feature) => {
					const display = FEATURE_DISPLAY[feature.featureId]
					const label = display?.label ?? feature.featureId
					const formatUnits = display?.formatUnits ?? formatCount
					return (
						<div
							key={feature.featureId}
							className="flex items-baseline justify-between gap-4 text-xs"
						>
							<span className="text-muted-foreground">
								{label}
								<span className="text-muted-foreground/60">
									{" · "}
									{formatUnits(feature.overageUnits)} over × {formatRate(feature.rate)}
								</span>
							</span>
							<span className="tabular-nums text-foreground">{formatCurrency(feature.cost)}</span>
						</div>
					)
				})}
			</div>
			<p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/70">
				Estimated from current usage and your plan's per-unit rates. Final charges appear on your
				invoice.
			</p>
		</div>
	)
}
