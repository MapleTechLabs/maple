import { EMPTY_VALUE, formatBytes } from "@maple/ui/lib/format"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { type UtilizationLevel, utilizationLevel } from "@maple/ui/lib/utilization"

// Generic number/byte/percent formatting lives in `@maple/ui/lib/format`; only
// infra-specific status policy stays here.

/**
 * Collector freshness, which is all a metrics window can honestly report.
 *
 * `ended` is deliberately not "down": a series that stops mid-window means the
 * resource stopped reporting, and for a pod on an autoscaled fleet that is
 * almost always a normal termination — scale-in, a rollout, a replaced Fargate
 * task. Calling that an error painted the expected case red. A real down state
 * needs an expectation signal (`k8s.pod.phase`, or a workload's available vs
 * desired replicas), and belongs beside these rather than instead of them.
 */
export type HostStatus = "active" | "idle" | "ended"
export type SeverityLevel = UtilizationLevel

/** Utilization fraction → tone; the shared thresholds in `@maple/ui/lib/utilization`. */
export const severityLevel: (fraction: number) => SeverityLevel = utilizationLevel

const SCRAPE_INTERVAL_MS = 30_000

export function deriveHostStatus(lastSeenIso: string, reference: number | string = Date.now()): HostStatus {
	const lastSeen = toEpochMs(lastSeenIso)
	if (!Number.isFinite(lastSeen)) return "ended"
	const referenceMs = typeof reference === "number" ? reference : toEpochMs(reference)
	const ref = Number.isFinite(referenceMs) ? referenceMs : Date.now()
	const age = ref - lastSeen
	if (age < SCRAPE_INTERVAL_MS * 2) return "active"
	if (age < SCRAPE_INTERVAL_MS * 10) return "idle"
	return "ended"
}

/** Whole-number percent of a 0-1 fraction; table cells want "7%", not formatPercent's "7.2%". */
export const formatWholePercent = (fraction: number) =>
	Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : EMPTY_VALUE

/** CPU usage in cores, two decimals. */
export const formatCores = (cores: number) => (Number.isFinite(cores) ? cores.toFixed(2) : EMPTY_VALUE)

/**
 * A node's usage / allocatable fraction, or NaN when allocatable was not collected
 * (the API sends 0 for both), so meters and percents render a dash instead of 0%.
 */
export const capacityFraction = (utilization: number, allocatable: number) =>
	allocatable > 0 ? utilization : Number.NaN

/** "0.42 / 3.92 cores"; usage alone when allocatable was not collected. */
export const formatCoresOfAllocatable = (usage: number, allocatable: number) =>
	allocatable > 0
		? `${formatCores(usage)} / ${formatCores(allocatable)} cores`
		: `${formatCores(usage)} cores`

/** "3.1 GB / 15.6 GB"; usage alone when allocatable was not collected. */
export const formatBytesOfAllocatable = (usage: number, allocatable: number) =>
	allocatable > 0 ? `${formatBytes(usage)} / ${formatBytes(allocatable)}` : formatBytes(usage)
