// The hosts list's fleet band: the container band's shape, counted client-side
// because the hosts list already carries the fleet (up to `HOST_LIST_LIMIT`).

import type { HostRow } from "./host-table"
import { countHostScopes, type HostScope } from "./host-scopes"
import { FleetBand, FleetBandLoading } from "./primitives/fleet-band"
import { TONE_FILL } from "@maple/ui/lib/tone"

export { HOST_LIST_LIMIT, hostInScope, type HostScope } from "./host-scopes"

export function HostSummaryBand({
	hosts,
	referenceTime,
	activeScope,
	onScopeChange,
	className,
}: {
	hosts: ReadonlyArray<HostRow>
	referenceTime: string
	activeScope?: HostScope
	onScopeChange: (scope: HostScope | undefined) => void
	className?: string
}) {
	const { total, saturated, elevated, stale } = countHostScopes(hosts, referenceTime)
	const healthy = Math.max(total - saturated - elevated, 0)

	return (
		<FleetBand<HostScope>
			total={total}
			noun="host"
			caption="share of the fleet by its busiest of CPU, memory and disk"
			segments={[
				{ key: "healthy", count: healthy, className: TONE_FILL.ok },
				{ key: "elevated", count: elevated, className: TONE_FILL.warn },
				{ key: "saturated", count: saturated, className: TONE_FILL.crit },
			]}
			cells={[
				{ scope: "saturated", label: "Saturated", hint: "≥90%", value: saturated, tone: "crit" },
				{ scope: "elevated", label: "Elevated", hint: "≥60%", value: elevated, tone: "warn" },
				{ scope: "stale", label: "Stopped reporting", hint: ">5m", value: stale, tone: "neutral" },
			]}
			activeScope={activeScope}
			onScopeChange={onScopeChange}
			className={className}
		/>
	)
}

export function HostSummaryBandLoading({ className }: { className?: string }) {
	return <FleetBandLoading cells={3} className={className} />
}
