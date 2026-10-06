import { FactLane, FactStrip } from "@/components/errors/fact-strip"
import type { V2Investigation } from "@maple/domain/http/v2"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { getServiceColor } from "@maple/ui/lib/colors"
import { toEpochMs } from "@maple/ui/lib/time-format"

/**
 * Four named lanes under the verdict, each reading a field that has been on the
 * wire the whole time and rendered nowhere — `report.affectedScope`, the union of
 * `evidence[].relatedServices`, the snapshot's incident window, and its
 * occurrence count.
 *
 * "Blast radius" was here once as an events-*and-users* count and was deleted,
 * because the user half was invented and a fabricated user count inside an impact
 * strip is the most dangerous number that could be on this page. It is back as
 * events alone: `snapshot.occurrence_count` is a real field written when the
 * investigation was opened, and the lane hides entirely when it is absent. The
 * user count stays gone — nothing in the warehouse counts affected users for a
 * backend service, and "0 users" would be a worse lie than silence.
 *
 * Fixed lane widths rather than `gap` alone: the lanes have to hold their
 * vertical rules in place as the rail widens and narrows, and a flex-only strip
 * re-wraps the moment the right panel opens.
 */
export function ImpactStrip({ investigation }: { investigation: V2Investigation }) {
	const { report, snapshot } = investigation
	const isSettled = investigation.status !== "investigating"

	const services = servicesTouched(investigation)
	const window = incidentWindow(snapshot)
	const occurrences = snapshot.occurrenceCount

	return (
		<FactStrip>
			<FactLane label="Affected scope">
				<span className="text-foreground">
					{report?.affectedScope?.trim() || (isSettled ? "Not determined" : "Not yet determined")}
				</span>
			</FactLane>
			<FactLane label="Services touched">
				{services.length === 0 ? (
					<span className="text-muted-foreground">None recorded</span>
				) : (
					<span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
						{services.map((service) => (
							<span key={service} className="flex items-center gap-1.5">
								<span
									aria-hidden
									className="size-1.5 shrink-0 rounded-[3px]"
									style={{ backgroundColor: getServiceColor(service) }}
								/>
								<span className="text-foreground">{service}</span>
							</span>
						))}
					</span>
				)}
			</FactLane>
			<FactLane label="Incident window">
				<span className="text-foreground tabular-nums">{window}</span>
			</FactLane>
			{occurrences != null && Number.isFinite(occurrences) ? (
				<FactLane label="Blast radius">
					<span className="text-foreground">
						<span className="tabular-nums">{formatNumber(occurrences)}</span>{" "}
						<span className="text-muted-foreground">
							{occurrences === 1 ? "event" : "events"}
						</span>
					</span>
				</FactLane>
			) : null}
		</FactStrip>
	)
}

/**
 * Every distinct service any piece of evidence touched, in first-seen order.
 * Deduped — the same service usually appears on several findings, and printing
 * it three times says nothing.
 */
export function servicesTouched(investigation: V2Investigation): ReadonlyArray<string> {
	const seen = new Set<string>()
	for (const evidence of investigation.report?.evidence ?? []) {
		for (const service of evidence.relatedServices) {
			const name = service.trim()
			if (name) seen.add(name)
		}
	}
	// The scope is a service name often enough to be worth falling back to, and a
	// lane reading "None recorded" on a diagnosed incident looks broken.
	if (seen.size === 0) {
		const scope = investigation.snapshot.scope?.trim()
		if (scope && !scope.includes(" ")) seen.add(scope)
	}
	return [...seen]
}

/** `14:02 → 14:26 · 24m`, or as much of it as the snapshot actually carries. */
function incidentWindow(snapshot: V2Investigation["snapshot"]): string {
	const startedAt = snapshot.incidentStartedAt
	if (!startedAt) return "Not recorded"
	const startMs = toEpochMs(startedAt)
	if (!Number.isFinite(startMs)) return "Not recorded"
	const start = clockTime(startMs)

	const endedAt = snapshot.incidentEndedAt
	if (!endedAt) return `${start} → ongoing`
	const endMs = toEpochMs(endedAt)
	if (!Number.isFinite(endMs) || endMs < startMs) return `${start} → ongoing`
	return `${start} → ${clockTime(endMs)} · ${formatDuration(endMs - startMs)}`
}

const clockTime = (epochMs: number) =>
	new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
