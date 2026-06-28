import { Link } from "@tanstack/react-router"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"
import type { AiTriageResult, AiTriageRunDocument } from "@maple/domain/http"

import { ArrowPathIcon, ArrowRightIcon } from "@/components/icons"
import { ConfidenceMeter, EYEBROW } from "@/components/ai-triage/ai-triage-card"
import { formatBreach, toAlertComparator, toAlertSignalType } from "@/components/ai-triage/breach"
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/components/errors/severity-badge"
import type { AlertContext } from "@/components/chat/alert-context"
import { comparatorLabels, signalLabels } from "@/lib/alerts/form-utils"
import { formatRelativeTime } from "@/lib/format"

export interface IncidentReportSidebarProps {
	alertContext: AlertContext
	/** Latest completed result (drives the assessed severity + confidence); null while pending. */
	result: AiTriageResult | null
	/** Latest run (drives the investigated-at + model lines); null before the first run. */
	run: AiTriageRunDocument | null
	onRerun: () => void
	rerunning: boolean
}

/**
 * The report's left meta rail: an at-a-glance scorecard (assessed severity, AI
 * confidence, breach magnitude) over the signal facts, blast radius, and timing.
 * Mirrors the anomaly detail sidebar's Group/Row vocabulary.
 */
export function IncidentReportSidebar({ alertContext, result, run, onRerun, rerunning }: IncidentReportSidebarProps) {
	const signalType = toAlertSignalType(alertContext.signalType)
	const comparator = toAlertComparator(alertContext.comparator)
	const breach =
		signalType && comparator
			? formatBreach(signalType, comparator, alertContext.value, alertContext.threshold)
			: null

	const services = result ? [...new Set(result.evidence.flatMap((e) => e.relatedServices))] : []
	const investigatedAt = run?.completedAt ?? run?.createdAt ?? null

	return (
		<div className="flex min-h-full flex-col">
			<Group label="Assessment">
				<Row label="Severity">
					{result ? (
						<Badge variant="outline" className={cn("capitalize", SEVERITY_TONE[result.severityAssessment])}>
							{SEVERITY_LABEL[result.severityAssessment]}
						</Badge>
					) : (
						<span className="text-sm text-muted-foreground/60">Pending</span>
					)}
				</Row>
				<Row label="Confidence">
					{result ? (
						<ConfidenceMeter confidence={result.confidence} showLabel={false} />
					) : (
						<span className="text-sm text-muted-foreground/60">Pending</span>
					)}
				</Row>
				{breach ? (
					<div className="grid grid-cols-[88px_1fr] items-baseline gap-x-3 py-0.5">
						<span className="text-xs text-muted-foreground">Breach</span>
						<div className="flex min-w-0 flex-col items-end gap-0.5">
							<span className="font-mono text-sm tabular-nums text-foreground">
								{breach.observed}{" "}
								<span className="text-muted-foreground">vs {breach.threshold}</span>
							</span>
							{breach.delta ? (
								<span
									className={cn(
										"whitespace-nowrap text-xs font-medium tabular-nums",
										breach.exceedsThreshold ? "text-destructive" : "text-muted-foreground",
									)}
								>
									{breach.delta}
								</span>
							) : null}
						</div>
					</div>
				) : null}
			</Group>

			<Group label="Signal">
				<Row label="Metric">
					<span className="text-sm text-foreground">
						{signalType ? signalLabels[signalType] : alertContext.signalType}
					</span>
				</Row>
				<Row label="Condition">
					<span className="font-mono text-xs tabular-nums text-muted-foreground">
						{comparator ? comparatorLabels[comparator] : alertContext.comparator} {breach?.threshold ?? alertContext.threshold}
					</span>
				</Row>
				<Row label="Window">
					<span className="text-sm tabular-nums text-foreground">{alertContext.windowMinutes}min</span>
				</Row>
				{alertContext.groupKey ? (
					<Row label="Group" title={alertContext.groupKey}>
						<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
							{alertContext.groupKey}
						</code>
					</Row>
				) : null}
				{alertContext.sampleCount !== null ? (
					<Row label="Samples">
						<span className="font-mono text-sm tabular-nums text-muted-foreground">
							{alertContext.sampleCount.toLocaleString()}
						</span>
					</Row>
				) : null}
			</Group>

			{result ? (
				<Group label="Blast radius">
					<p className="text-sm leading-relaxed text-foreground">{result.affectedScope}</p>
					{services.length > 0 ? (
						<div className="flex flex-wrap gap-1 pt-1">
							{services.map((service) => (
								<Badge key={service} variant="outline" className="text-[11px]">
									{service}
								</Badge>
							))}
						</div>
					) : null}
				</Group>
			) : null}

			{investigatedAt ? (
				<Group label="Timing">
					<Row label="Investigated" title={new Date(investigatedAt).toLocaleString()}>
						<span className="text-right text-sm tabular-nums text-foreground">
							{formatRelativeTime(investigatedAt)}
						</span>
					</Row>
					{run?.model ? (
						<Row label="Model" title={run.model}>
							<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
								{run.model}
							</code>
						</Row>
					) : null}
				</Group>
			) : null}

			<div className="flex flex-col gap-2 pt-4">
				<Button size="sm" variant="outline" className="w-full" onClick={onRerun} disabled={rerunning}>
					<ArrowPathIcon className="size-3.5" />
					Re-run diagnosis
				</Button>
				<Button
					size="sm"
					variant="ghost"
					className="w-full text-muted-foreground"
					render={<Link to="/alerts/$ruleId" params={{ ruleId: alertContext.ruleId }} />}
				>
					View alert rule
					<ArrowRightIcon className="size-3" />
				</Button>
			</div>
		</div>
	)
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2 border-b border-border/40 py-4 first:pt-0">
			<h3 className={EYEBROW}>{label}</h3>
			<div className="flex flex-col gap-1">{children}</div>
		</section>
	)
}

function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
	return (
		<div title={title} className="grid min-h-8 grid-cols-[88px_1fr] items-center gap-x-3 py-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<div className="flex min-w-0 items-center justify-end">{children}</div>
		</div>
	)
}
