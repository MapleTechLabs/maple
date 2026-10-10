import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { Link } from "@tanstack/react-router"
import type { AnomalyIncidentDocument } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { TruncatedId } from "@maple/ui/components/ui/truncated-id"
import { cn } from "@maple/ui/lib/utils"

import { RelativeTime } from "@/components/common/relative-time"
import { LinkIcon } from "@/components/icons"
import { shortIssueId } from "@/components/errors/issue-id"
import {
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	META_CHIP_CLASS,
	RESOLVE_REASON_LABEL,
	SIGNAL_LABEL,
	severityToneFor,
	TRIAGE_STATUS_CHIP,
} from "./anomaly-format"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { DetailRail } from "@maple/ui/components/detail-rail"
import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"

export function AnomalySidebar({
	incident,
	busy,
	onResolve,
	onOpenLinkDialog,
	onUnlink,
}: {
	incident: AnomalyIncidentDocument
	busy: boolean
	onResolve: () => void
	onOpenLinkDialog: () => void
	onUnlink: () => void
}) {
	const isOpen = incident.status === "open"
	const isStale = isStaleOpenIncident(incident)
	const tone = severityToneFor(incident)
	const dev = deviation(incident)
	const triageChip = TRIAGE_STATUS_CHIP[incident.triageStatus]
	const fmt = (value: number) => formatSignalValue(incident.signalType, value)

	return (
		<div className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l bg-card/30">
			<DetailRail.Group label="Actions">
				{isOpen ? (
					<Button
						size="sm"
						variant="outline"
						className="w-full"
						onClick={onResolve}
						disabled={busy}
					>
						Resolve anomaly
					</Button>
				) : null}
				{incident.errorIssueId === null ? (
					<Button
						size="sm"
						variant="outline"
						className="w-full"
						onClick={onOpenLinkDialog}
						disabled={busy}
					>
						<LinkIcon />
						Link issue
					</Button>
				) : (
					<Button size="sm" variant="outline" className="w-full" onClick={onUnlink} disabled={busy}>
						Unlink {shortIssueId(incident.errorIssueId)}
					</Button>
				)}
			</DetailRail.Group>

			<DetailRail.Group label="Details">
				<DetailRail.Row label="State">
					<span className="text-right text-sm text-foreground">
						{isStale ? (
							<>
								stale · <RelativeTime value={incident.lastTriggeredAt} prefix="last seen" />
							</>
						) : isOpen ? (
							"open"
						) : (
							"resolved"
						)}
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Signal">
					<span className="text-sm text-foreground">{SIGNAL_LABEL[incident.signalType]}</span>
				</DetailRail.Row>
				<DetailRail.Row label="Severity">
					<span
						className={cn(
							"text-sm font-medium",
							isOpen && !isStale ? tone.text : "text-muted-foreground",
						)}
					>
						{incident.severity}
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Service" title={incident.serviceName}>
					<span className="flex min-w-0 items-center gap-2">
						<ServiceDot serviceName={incident.serviceName} size="sm" />
						<span className="truncate text-sm text-foreground">{incident.serviceName}</span>
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Environment">
					<span className="text-sm text-foreground">{incident.deploymentEnv || EMPTY_VALUE}</span>
				</DetailRail.Row>
				<DetailRail.Row label="Detector" title={incident.detectorKey}>
					<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
						{incident.detectorKey}
					</code>
				</DetailRail.Row>
				{incident.fingerprintHash !== null ? (
					<DetailRail.Row label="Fingerprint" title={incident.fingerprintHash}>
						<code className="block max-w-full truncate font-mono text-xs text-muted-foreground">
							{incident.fingerprintHash}
						</code>
					</DetailRail.Row>
				) : null}
			</DetailRail.Group>

			<DetailRail.Group label="Values">
				<DetailRail.Row label="Observed">
					<span
						className={cn(
							"font-mono text-sm tabular-nums",
							isOpen && !isStale ? tone.text : "text-foreground",
						)}
					>
						{fmt(incident.lastObservedValue)}
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="At open">
					<span className="font-mono text-sm tabular-nums text-muted-foreground">
						{fmt(incident.openedValue)}
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Baseline">
					<span className="font-mono text-sm tabular-nums text-muted-foreground">
						{fmt(incident.baselineMedian)}
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Threshold">
					<span className="font-mono text-sm tabular-nums text-muted-foreground">
						{fmt(incident.thresholdValue)}
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Deviation">
					<span
						className={cn(
							"font-mono text-sm tabular-nums",
							isOpen && !isStale ? tone.text : "text-foreground",
						)}
					>
						{dev.label}
					</span>
				</DetailRail.Row>
				<DetailRail.Row label="Samples">
					<span className="font-mono text-sm tabular-nums text-muted-foreground">
						{formatNumber(incident.lastSampleCount)}
					</span>
				</DetailRail.Row>
			</DetailRail.Group>

			{incident.fingerprints.length > 1 ? (
				<DetailRail.Group label={`Grouped errors · ${incident.fingerprints.length}`}>
					{incident.fingerprints.map((fingerprint) => (
						<div
							key={fingerprint.fingerprintHash}
							className="grid min-h-7 grid-cols-[1fr_auto] items-center gap-x-2 py-0.5"
							title={fingerprint.fingerprintHash}
						>
							<span className="flex min-w-0 items-center gap-1.5">
								<StatusDot
									tone={
										fingerprint.resolvedAt !== null
											? "neutral"
											: fingerprint.severity === "critical"
												? "crit"
												: "warn"
									}
								/>
								{fingerprint.errorIssueId !== null ? (
									<Link
										to="/errors/issues/$issueId"
										params={{ issueId: fingerprint.errorIssueId }}
										className="truncate font-mono text-xs text-muted-foreground hover:text-foreground"
									>
										{shortIssueId(fingerprint.errorIssueId)}
									</Link>
								) : (
									<TruncatedId
										value={fingerprint.fingerprintHash}
										length={10}
										className="truncate text-xs text-muted-foreground"
									/>
								)}
							</span>
							<span className="font-mono text-xs tabular-nums text-muted-foreground">
								{fingerprint.resolvedAt !== null ? "resolved" : fmt(fingerprint.lastValue)}
							</span>
						</div>
					))}
				</DetailRail.Group>
			) : null}

			<DetailRail.Group label="Timing">
				<DetailRail.Row label="First triggered">
					<RelativeTime
						value={incident.firstTriggeredAt}
						tooltip="title"
						className="text-right text-sm tabular-nums text-foreground"
					/>
				</DetailRail.Row>
				{incident.reopenCount > 0 && incident.lastReopenedAt !== null ? (
					<DetailRail.Row label="Reopened">
						<span className="text-right text-sm tabular-nums text-muted-foreground">
							<RelativeTime value={incident.lastReopenedAt} tooltip="title" />
							{incident.reopenCount > 1 ? ` (×${incident.reopenCount})` : ""}
						</span>
					</DetailRail.Row>
				) : null}
				<DetailRail.Row label="Last triggered">
					<RelativeTime
						value={incident.lastTriggeredAt}
						tooltip="title"
						className="text-right text-sm tabular-nums text-foreground"
					/>
				</DetailRail.Row>
				{incident.resolvedAt !== null ? (
					<DetailRail.Row label="Resolved">
						<RelativeTime
							value={incident.resolvedAt}
							tooltip="title"
							className="text-right text-sm tabular-nums text-muted-foreground"
						/>
					</DetailRail.Row>
				) : null}
				{incident.resolveReason !== null ? (
					<DetailRail.Row label="Reason">
						<span className="text-right text-sm text-muted-foreground">
							{RESOLVE_REASON_LABEL[incident.resolveReason]}
						</span>
					</DetailRail.Row>
				) : null}
			</DetailRail.Group>

			<DetailRail.Group label="Triage">
				{triageChip ? (
					<Badge
						pill
						size="sm"
						className={cn(META_CHIP_CLASS, "w-fit font-medium", triageChip.tone)}
					>
						{triageChip.label}
					</Badge>
				) : (
					<p className="text-xs text-muted-foreground">No AI triage has run for this incident.</p>
				)}
			</DetailRail.Group>
		</div>
	)
}
