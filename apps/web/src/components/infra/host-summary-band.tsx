// The hosts list's fleet band: the container band's shape, counted client-side
// because the hosts list already carries the fleet (up to `HOST_LIST_LIMIT`).

import { deriveHostStatus, severityLevel } from "./format"
import type { HostRow } from "./host-table"
import { FleetBand, FleetBandLoading } from "./primitives/fleet-band"

export type HostScope = "saturated" | "elevated" | "stale"

/**
 * Hosts the list asks for. The query orders by last seen, so past this the
 * oldest hosts drop first; the page says so rather than counting a sample.
 */
export const HOST_LIST_LIMIT = 1000

/** A host's worst utilization across CPU, memory and disk, 0..1. */
export function hostPeak(host: HostRow): number {
	return Math.max(host.cpuPct, host.memoryPct, host.diskPct)
}

export function hostInScope(host: HostRow, scope: HostScope, reference: string): boolean {
	if (scope === "stale") return deriveHostStatus(host.lastSeen, reference) === "ended"
	const level = severityLevel(hostPeak(host))
	return scope === "saturated" ? level === "crit" : level === "warn"
}

export function countHostScopes(hosts: ReadonlyArray<HostRow>, reference: string) {
	let saturated = 0
	let elevated = 0
	let stale = 0
	for (const host of hosts) {
		if (hostInScope(host, "saturated", reference)) saturated++
		else if (hostInScope(host, "elevated", reference)) elevated++
		if (hostInScope(host, "stale", reference)) stale++
	}
	return { total: hosts.length, saturated, elevated, stale }
}

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
				{ key: "healthy", count: healthy, className: "bg-muted-foreground/35" },
				{ key: "elevated", count: elevated, className: "bg-[var(--severity-warn)]" },
				{ key: "saturated", count: saturated, className: "bg-[var(--severity-error)]" },
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
