import type * as React from "react"

import { formatCurrency } from "@maple/domain/format"
import { Badge } from "@maple/ui/components/ui/badge"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatFigure } from "@maple/ui/components/ui/stat-figure"
import { cn } from "@maple/ui/lib/utils"

import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import type { TrialStatus } from "@/lib/billing/plan-gating"
import { sentenceCasePlanName } from "@/lib/billing/plans"
import type { SpendModel } from "@/lib/billing/spend"
import { formatDateInTimezone } from "@/lib/timezone-format"
import { CostBreakdown } from "./cost-breakdown"

const dollars = (cents: number, currency: string) => formatCurrency(cents / 100, currency)

function Figure({
	label,
	value,
	note,
	valueClassName,
	className,
}: {
	label: string
	value: string
	note: React.ReactNode
	valueClassName?: string
	className?: string
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-2 p-4", className)}>
			<span className="text-2xs font-medium text-muted-foreground">{label}</span>
			<StatFigure size="lg" value={value} valueClassName={valueClassName} />
			<span className="text-2xs text-muted-foreground">{note}</span>
		</div>
	)
}

export function BillingCyclePanelSkeleton() {
	return (
		<Panel>
			<div className="flex items-center justify-between border-b px-4 py-3">
				<Skeleton className="h-4 w-28" />
				<Skeleton className="h-3.5 w-44" />
			</div>
			<div className="grid grid-cols-1 border-b sm:grid-cols-3">
				{[0, 1, 2].map((index) => (
					<div key={index} className="flex flex-col gap-2 p-4">
						<Skeleton className="h-2.5 w-16" />
						<Skeleton className="h-6 w-24" />
						<Skeleton className="h-2.5 w-28" />
					</div>
				))}
			</div>
			<Skeleton className="m-4 h-40" />
		</Panel>
	)
}

/**
 * This cycle in one panel: plan and period once, the three figures that answer
 * "what will I pay", the cumulative chart, and the breakdown behind the spend.
 * Every number is read off the one spend model.
 */
export function BillingCyclePanel({
	model,
	trial,
	isLegacy,
	maximumInvoiceCents,
	uncappedCount,
	onSetCaps,
	setCapsDisabled = false,
	chart,
}: {
	model: SpendModel
	trial: TrialStatus
	isLegacy: boolean
	/** Base plus every paid overage cap; null while any billable feature is uncapped. */
	maximumInvoiceCents: number | null
	uncappedCount: number
	/** Opens the usage table's cap editor; omitted for members, who cannot set caps. */
	onSetCaps?: () => void
	/** True while a cap save is in flight, so the link cannot switch the open editor. */
	setCapsDisabled?: boolean
	chart: React.ReactNode
}) {
	const { effectiveTimezone: timeZone } = useTimezonePreference()
	const start = new Date(model.cycle.startMs)
	const end = new Date(model.cycle.endMs)
	const period = `${formatDateInTimezone(start, { timeZone, withYear: false })} – ${formatDateInTimezone(end, { timeZone })}`
	const trialing = trial.isTrialing && trial.daysRemaining !== null

	return (
		<Panel className="overflow-hidden">
			<div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium">
						{model.planName === null ? "No plan" : sentenceCasePlanName(model.planName)}
					</span>
					{trial.planStatus !== null && (
						<Badge size="sm" variant={trialing ? "warn" : "ok"}>
							{trialing ? `Trial, ${trial.daysRemaining}d left` : "Active"}
						</Badge>
					)}
					{isLegacy && (
						<Badge size="sm" variant="warn">
							Legacy
						</Badge>
					)}
				</div>
				<div className="flex items-center gap-2 text-xs tabular-nums">
					<span>{period}</span>
					<span className="text-muted-foreground">·</span>
					<span className="text-muted-foreground">
						Day {model.dayOfCycle} of {model.cycleDays}
					</span>
				</div>
			</div>

			<div className="grid grid-cols-1 divide-y border-b sm:grid-cols-3 sm:divide-x sm:divide-y-0">
				<Figure
					label="Spent so far"
					value={dollars(model.spendCents, model.currency)}
					note={
						model.partial ? "At least; some items aren't itemized" : "Excludes taxes and credits"
					}
				/>
				<Figure
					label="Projected"
					value={dollars(model.projectedCents, model.currency)}
					valueClassName="text-primary"
					note="At this cycle's daily rate"
				/>
				<Figure
					label="Maximum invoice"
					value={
						maximumInvoiceCents === null
							? "Uncapped"
							: dollars(maximumInvoiceCents, model.currency)
					}
					note={
						maximumInvoiceCents !== null ? (
							"Base plan plus every overage cap"
						) : uncappedCount === 0 ? (
							"Some items can't be priced"
						) : (
							<span className="flex flex-wrap items-center gap-x-1.5">
								{uncappedCount === 1
									? "1 feature has no cap"
									: `${uncappedCount} features have no cap`}
								{onSetCaps && (
									<button
										type="button"
										onClick={onSetCaps}
										disabled={setCapsDisabled}
										className="font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
									>
										Set caps
									</button>
								)}
							</span>
						)
					}
				/>
			</div>

			<div className="border-b">{chart}</div>

			<CostBreakdown model={model} />

			{trialing && trial.trialEndsAt !== null && (
				<p className="border-t px-4 py-2.5 text-2xs text-muted-foreground">
					Your card is charged when the trial ends on{" "}
					{formatDateInTimezone(trial.trialEndsAt, { timeZone, withYear: false })}. Cancel before
					then to avoid charges.
				</p>
			)}
		</Panel>
	)
}
