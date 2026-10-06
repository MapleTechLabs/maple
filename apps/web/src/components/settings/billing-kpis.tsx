import { StatRail, StatRailItem, StatRailLoading } from "@/components/common/stat-rail"

import { formatCurrency } from "@maple/domain/format"
import { FEATURE_COLORS, type SpendModel } from "@/lib/billing/spend"
import { formatFeatureUsage } from "./format-feature-usage"

/**
 * The four numbers that answer "what is this cycle costing me?" before the
 * reader touches a chart: spend so far, where it lands, the ceiling it's headed
 * for, and which signal is driving it.
 *
 * Deliberately four cards and not a chart summary — this row is what a customer
 * screenshots into a finance thread.
 */

const dollars = (cents: number, currency: string) => formatCurrency(cents / 100, currency)

export function BillingKpisSkeleton() {
	return <StatRailLoading />
}

export function BillingKpis({
	model,
	maximumInvoiceCents,
}: {
	model: SpendModel
	/** Base plus every configured paid-overage cap; null when any feature is uncapped. */
	maximumInvoiceCents: number | null
}) {
	const driver = model.topDriver

	// Sublines here carry the arithmetic behind the number, so they wrap instead of truncating.
	const wrap = (text: React.ReactNode) => <span className="whitespace-normal leading-snug">{text}</span>

	return (
		<StatRail className="rounded-none">
			<StatRailItem
				compact
				eyebrow="Spend so far"
				value={dollars(model.spendCents, model.currency)}
				subline={wrap(
					<>
						Day {model.dayOfCycle} of {model.cycleDays} · {dollars(model.baseCents, model.currency)}{" "}
						base + {dollars(model.overageCents, model.currency)} overage
						{model.partial && " · some legacy items aren't itemized"}
					</>,
				)}
			/>
			<StatRailItem
				compact
				eyebrow="Projected bill"
				value={dollars(model.projectedCents, model.currency)}
				valueClassName="text-primary"
				subline="At the current pace"
			/>
			{maximumInvoiceCents === null ? (
				<StatRailItem
					compact
					eyebrow="Maximum invoice"
					value="Uncapped"
					valueClassName="text-muted-foreground"
					subline={wrap("At least one paid feature has no overage cap")}
				/>
			) : (
				<StatRailItem
					compact
					eyebrow="Maximum invoice"
					value={dollars(maximumInvoiceCents, model.currency)}
					subline={wrap("Base plan plus all paid-overage caps")}
				/>
			)}
			{driver === null ? (
				<StatRailItem
					compact
					eyebrow="Top cost driver"
					value="Within included"
					valueClassName="font-sans text-lg font-normal"
					subline={wrap("No feature is over its allotment this cycle")}
				/>
			) : (
				<StatRailItem
					compact
					eyebrow="Top cost driver"
					valueClassName="flex items-baseline gap-2 font-sans text-lg font-normal"
					value={
						<>
							<span
								aria-hidden
								className="size-2 shrink-0 rounded-full"
								style={{ background: FEATURE_COLORS[driver.featureId] }}
							/>
							<span>{driver.label}</span>
							<span className="font-mono text-sm tabular-nums text-muted-foreground">
								{dollars(driver.overageCents, model.currency)}
							</span>
						</>
					}
					subline={wrap(
						<>
							{model.overageCents > 0
								? `${Math.round((driver.overageCents / model.overageCents) * 100)}% of overage · `
								: ""}
							{formatFeatureUsage(driver.featureId, driver.overageUnits)} over included
						</>,
					)}
				/>
			)}
		</StatRail>
	)
}
