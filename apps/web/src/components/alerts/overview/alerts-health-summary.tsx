import { AlertStatCell, AlertStatShell } from "@/components/alerts/alert-stat-card"

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
	tone: string
	activeClass: string
}> = [
	{
		key: "firing",
		label: "Firing",
		hint: "open incidents",
		tone: "text-destructive",
		activeClass: "ring-destructive/50 bg-destructive/[0.04]",
	},
	{
		key: "attention",
		label: "Needs attention",
		hint: "errors · stale · unrouted",
		tone: "text-warning",
		activeClass: "ring-warning/50 bg-warning/[0.05]",
	},
	{
		key: "healthy",
		label: "Healthy",
		hint: "evaluating normally",
		tone: "text-success",
		activeClass: "ring-success/50 bg-success/[0.05]",
	},
	{
		key: "disabled",
		label: "Disabled",
		hint: "not evaluating",
		tone: "text-muted-foreground",
		activeClass: "ring-border bg-muted/40",
	},
]

/**
 * Row of four clickable health buckets that leads the alerts overview. Follows
 * the flat divider-separated strip treatment from `alert-stat-card.tsx` (a
 * `bg-border` backplate showing through 1px gaps) rather than a card grid; the
 * active filter is marked with an inset ring + tint so it survives the
 * `overflow-hidden` container. Clicking the active card clears the filter.
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
		<AlertStatShell>
			{cards.map((card) => {
				const count = counts[card.key]
				const isActive = active === card.key
				return (
					<AlertStatCell
						key={card.key}
						label={card.label}
						value={count}
						hint={card.hint}
						valueClassName={count > 0 ? card.tone : "text-muted-foreground/60"}
						onSelect={() => onActiveChange(isActive ? undefined : card.key)}
						selected={isActive}
						selectedClassName={card.activeClass}
					/>
				)
			})}
		</AlertStatShell>
	)
}
