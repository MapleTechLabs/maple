import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import type { Tone } from "@maple/ui/lib/tone"

/** Health buckets a rule can land in — mirrors the `status` search param. */
export type AlertsStatusFilter = "firing" | "attention" | "healthy" | "disabled"

export interface AlertsHealthCounts {
	firing: number
	attention: number
	healthy: number
	disabled: number
}

const cards: Array<{
	key: AlertsStatusFilter
	label: string
	hint: string
	/** Value tone when the bucket is non-empty. */
	tone: Tone
}> = [
	{ key: "firing", label: "Firing", hint: "open incidents", tone: "crit" },
	{ key: "attention", label: "Needs attention", hint: "errors · stale · unrouted", tone: "warn" },
	{ key: "healthy", label: "Healthy", hint: "evaluating normally", tone: "info" },
	{ key: "disabled", label: "Disabled", hint: "not evaluating", tone: "neutral" },
]

/**
 * Row of four clickable health buckets that leads the alerts overview, as a
 * `StatRail` of selectable tiles. Clicking the active tile clears the filter.
 */
export function AlertsHealthSummary({
	counts,
	active,
	onActiveChange,
}: {
	counts: AlertsHealthCounts
	active: AlertsStatusFilter | undefined
	onActiveChange: (status: AlertsStatusFilter | undefined) => void
}) {
	return (
		<StatRail>
			{cards.map((card) => {
				const count = counts[card.key]
				const isActive = active === card.key
				return (
					<StatRailItem
						key={card.key}
						size="sm"
						eyebrow={card.label}
						value={count}
						subline={card.hint}
						tone={card.tone}
						valueClassName={
							count === 0
								? "text-muted-foreground/60"
								: card.key === "disabled"
									? "text-muted-foreground"
									: undefined
						}
						onSelect={() => onActiveChange(isActive ? undefined : card.key)}
						selected={isActive}
					/>
				)
			})}
		</StatRail>
	)
}
