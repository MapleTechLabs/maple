import { TONE_FILL } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { fleetBand } from "../../kit/fleet-band"
import { countHostScopes } from "./derive"
import type { HostScope } from "./message"
import type { HostRow } from "./model"

// `HostSummaryBand`: the fleet split by busiest resource, with Saturated, Elevated and Stopped reporting
// as scope buttons.

export type HostSummaryBandOptions<M> = Readonly<{
	hosts: ReadonlyArray<HostRow>
	referenceTime: string
	activeScope: HostScope | undefined
	onScopeChange: (scope: HostScope | undefined) => M
	isWaiting?: boolean
	className?: string
}>

export const hostSummaryBand = <M>(h: HtmlBuilder<M>, options: HostSummaryBandOptions<M>): Html => {
	const counts = countHostScopes(options.hosts, options.referenceTime)
	const healthy = Math.max(counts.total - counts.saturated - counts.elevated, 0)
	return fleetBand(h, {
		total: counts.total,
		noun: "host",
		caption: "share of the fleet by its busiest of CPU, memory and disk",
		segments: [
			{ key: "healthy", count: healthy, className: TONE_FILL.ok },
			{ key: "elevated", count: counts.elevated, className: TONE_FILL.warn },
			{ key: "saturated", count: counts.saturated, className: TONE_FILL.crit },
		],
		cells: [
			{ scope: "saturated", label: "Saturated", hint: "≥90%", value: counts.saturated, tone: "crit" },
			{ scope: "elevated", label: "Elevated", hint: "≥60%", value: counts.elevated, tone: "warn" },
			{ scope: "stale", label: "Stopped reporting", hint: ">5m", value: counts.stale, tone: "neutral" },
		],
		activeScope: options.activeScope,
		onScopeChange: options.onScopeChange,
		isWaiting: options.isWaiting === true,
		className: options.className ?? "",
	})
}
