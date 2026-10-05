import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

import { PageHero } from "@/components/common/page-hero"

import { formatRelativeTime } from "@maple/ui/lib/time-format"
import {
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	SIGNAL_LABEL,
	severityToneFor,
} from "./anomaly-format"

export function AnomalyHero({
	incident,
	className,
}: {
	incident: AnomalyIncidentDocument
	className?: string
}) {
	const tone = severityToneFor(incident)
	const isStale = isStaleOpenIncident(incident)
	const dev = deviation(incident)
	const observed = formatSignalValue(incident.signalType, incident.lastObservedValue)
	const baseline = formatSignalValue(incident.signalType, incident.baselineMedian)
	const threshold = formatSignalValue(incident.signalType, incident.thresholdValue)

	return (
		<div className={cn("space-y-2", className)}>
			<Eyebrow as="div">Anomaly</Eyebrow>
			<PageHero
				title={
					<span className="break-words">
						{SIGNAL_LABEL[incident.signalType]}
						<span className="text-muted-foreground/60"> · </span>
						{incident.serviceName}
					</span>
				}
				description={
					<>
						{isStale ? "Last recorded" : "Observed"}{" "}
						<span
							className={cn(
								"font-mono font-medium",
								incident.status === "open" && !isStale ? tone.text : "text-foreground",
							)}
						>
							{observed}
						</span>{" "}
						against a <span className="font-mono text-foreground">{baseline}</span> 7-day baseline —{" "}
						<span
							className={cn(
								"font-mono font-medium",
								incident.status === "open" && !isStale ? tone.text : "text-foreground",
							)}
						>
							{dev.label}
						</span>
						{dev.kind === "sigma" ? " above median" : dev.kind === "percent" ? " vs baseline" : ""},
						threshold <span className="font-mono text-foreground">{threshold}</span>.
						{isStale
							? ` Last triggered ${formatRelativeTime(incident.lastTriggeredAt)}; this stale detector state does not represent current service health.`
							: ""}
					</>
				}
			/>
		</div>
	)
}
