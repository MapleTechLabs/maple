// The container list's fleet band — the pod band's shape on `FleetBand`, with
// no "unbounded" cell: running without limits is the norm in plain Docker, so
// it isn't a signal there.

import { FleetBand, FleetBandLoading } from "./primitives/fleet-band"
import { TONE_FILL } from "@maple/ui/lib/tone"

import type { ContainerScope, ContainerScopeCounts } from "./container-scopes"

export type { ContainerScope } from "./container-scopes"

interface ContainerSummaryBandProps {
	counts: ContainerScopeCounts
	activeScope?: ContainerScope
	onScopeChange: (scope: ContainerScope | undefined) => void
	waiting?: boolean
	className?: string
}

export function ContainerSummaryBand({
	counts,
	activeScope,
	onScopeChange,
	waiting,
	className,
}: ContainerSummaryBandProps) {
	const { totalContainers, saturatedContainers, elevatedContainers, staleContainers } = counts
	const healthy = Math.max(totalContainers - saturatedContainers - elevatedContainers, 0)

	return (
		<FleetBand<ContainerScope>
			total={totalContainers}
			noun="container"
			caption="share of the fleet by peak utilization"
			segments={[
				{ key: "healthy", count: healthy, className: TONE_FILL.ok },
				{ key: "elevated", count: elevatedContainers, className: TONE_FILL.warn },
				{ key: "saturated", count: saturatedContainers, className: TONE_FILL.crit },
			]}
			cells={[
				{
					scope: "saturated",
					label: "Saturated",
					hint: "≥90%",
					value: saturatedContainers,
					tone: "crit",
				},
				{
					scope: "elevated",
					label: "Elevated",
					hint: "≥60%",
					value: elevatedContainers,
					tone: "warn",
				},
				{
					scope: "stale",
					label: "Stale agent",
					hint: ">5m",
					value: staleContainers,
					tone: "neutral",
				},
			]}
			activeScope={activeScope}
			onScopeChange={onScopeChange}
			waiting={waiting}
			className={className}
		/>
	)
}

export function ContainerSummaryBandLoading({ className }: { className?: string }) {
	return <FleetBandLoading cells={3} className={className} />
}
