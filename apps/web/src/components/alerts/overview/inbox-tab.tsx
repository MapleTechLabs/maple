import { Link } from "@tanstack/react-router"
import { useMemo } from "react"

import type { AlertDestinationDocument, AlertIncidentDocument } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { countLabel, EMPTY_VALUE } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { AlertSeverityBadge } from "@/components/alerts/alert-severity-badge"
import { AlertsEmptyState } from "@/components/alerts/overview/alerts-empty-state"
import { HeadroomList } from "@/components/alerts/overview/headroom-list"
import { sortIncidents } from "@/components/alerts/overview/shared"
import { ROW_STRETCHED_LINK_CLASS } from "@/components/common/data-table"
import { formatAlertDuration, formatResolutionDuration, formatSignalValue } from "@/lib/alerts/form-utils"
import { quietForMs, ruleHeadroom } from "@/lib/alerts/headroom"
import {
	type BlindSpot,
	type BlindSpotKind,
	blindSpots as deriveBlindSpots,
	type FireLane,
	fireLanes,
	incidentTitle,
} from "@/lib/alerts/overview-derive"
import type { AlertsOverviewReady } from "@/lib/models/alerts-overview-model"

const HOUR_MS = 60 * 60 * 1000

/** Inbox: what is open right now, the last 24h of firing, and the rules that cannot fire. */
export function InboxTab({
	data,
	destinations,
	isAdmin,
	serviceName,
}: {
	data: AlertsOverviewReady
	destinations: ReadonlyArray<AlertDestinationDocument>
	isAdmin: boolean
	serviceName: string | undefined
}) {
	const { rules, incidents, openIncidents, derivedByRuleId, statesByRule, timelineRange } = data
	const now = timelineRange.max

	const sorted = useMemo(() => {
		const all = sortIncidents(openIncidents)
		return [...all.filter((i) => i.holdReason === null), ...all.filter((i) => i.holdReason !== null)]
	}, [openIncidents])
	const spots = useMemo(() => deriveBlindSpots(rules, derivedByRuleId), [rules, derivedByRuleId])
	const lanes = useMemo(() => fireLanes(incidents, timelineRange), [incidents, timelineRange])
	const headroom = useMemo(() => ruleHeadroom(rules, statesByRule), [rules, statesByRule])

	const held = sorted.filter((i) => i.holdReason !== null).length
	const firing = sorted.length - held
	const enabledRuleIds = rules.filter((r) => r.enabled).map((r) => r.id)
	const enabled = enabledRuleIds.length
	const disabled = rules.length - enabled
	const quiet = sorted.length === 0

	if (rules.length === 0) {
		return (
			<AlertsEmptyState
				isAdmin={isAdmin}
				hasDestinations={destinations.length > 0}
				serviceName={serviceName}
			/>
		)
	}

	const summary = [
		`${countLabel(enabled, "rule")} watching`,
		spots.length > 0 ? `${spots.length} can't fire or notify` : "all evaluating and routed",
		...(disabled > 0 ? [`${disabled} disabled`] : []),
	].join(" · ")

	return (
		<div className="space-y-8">
			<div className="space-y-1.5">
				<h2 className="text-2xl font-semibold tracking-tight tabular-nums">
					{quiet ? "Nothing firing" : `${firing} firing`}
					{quiet && <QuietStreak incidents={incidents} now={now} />}
					{held > 0 && (
						<span className="text-muted-foreground font-normal"> · {held} waiting on data</span>
					)}
				</h2>
				<p className="text-muted-foreground font-mono text-xs">{summary}</p>
			</div>

			{quiet ? (
				<>
					<HeadroomList rows={headroom} now={now} />
					{lanes.length === 0 && spots.length === 0 ? (
						// Two empty sections read as broken tables; one line says the same.
						<p className="font-mono text-xs text-muted-foreground">
							No rule fired in the last 24 hours · no blind spots: every enabled rule is
							evaluating and routed.
						</p>
					) : (
						<div className="grid gap-8 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
							<FireStrip
								lanes={lanes}
								incidents={incidents}
								range={timelineRange}
								enabledRuleIds={enabledRuleIds}
							/>
							<BlindSpotsList spots={spots} />
						</div>
					)}
				</>
			) : (
				<>
					<OpenIncidentsList incidents={sorted} />
					<div className="grid gap-8 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
						<FireStrip
							lanes={lanes}
							incidents={incidents}
							range={timelineRange}
							enabledRuleIds={enabledRuleIds}
						/>
						<BlindSpotsList spots={spots} />
					</div>
				</>
			)}
		</div>
	)
}

/* ── Quiet state ────────────────────────────────────────────────────────── */

function QuietStreak({ incidents, now }: { incidents: ReadonlyArray<AlertIncidentDocument>; now: number }) {
	const quietFor = quietForMs(incidents, now)
	return (
		<span className="font-normal text-muted-foreground">
			{" · "}
			{quietFor === null ? "quiet for 24h+" : `quiet for ${formatResolutionDuration(quietFor)}`}
		</span>
	)
}

/* ── Open incidents ─────────────────────────────────────────────────────── */

const INCIDENT_GRID = "grid grid-cols-[minmax(0,1fr)_150px_90px] items-center gap-4"

function OpenIncidentsList({ incidents }: { incidents: ReadonlyArray<AlertIncidentDocument> }) {
	return (
		<div className="overflow-x-auto rounded-md border">
			<div className="min-w-[560px]">
				<div className={cn(INCIDENT_GRID, "border-b px-4 py-2 text-xs text-muted-foreground")}>
					<span>Open · {incidents.length}</span>
					<span>Now / threshold</span>
					<span>Open for</span>
				</div>
				<ul className="divide-y">
					{incidents.map((incident) => (
						<OpenIncidentRow key={incident.id} incident={incident} />
					))}
				</ul>
			</div>
		</div>
	)
}

function OpenIncidentRow({ incident }: { incident: AlertIncidentDocument }) {
	const held = incident.holdReason !== null
	return (
		<li className={cn(INCIDENT_GRID, "relative px-4 py-3 hover:bg-muted/40")}>
			<span
				aria-hidden
				className={cn(
					"absolute inset-y-2 left-0 w-0.5 rounded-full",
					held
						? "bg-muted-foreground/50"
						: incident.severity === "critical"
							? "bg-severity-error"
							: "bg-severity-warn",
				)}
			/>
			<div className="min-w-0 space-y-1">
				<div className="flex min-w-0 items-center gap-2">
					{held ? (
						<Badge variant="outline" className="text-muted-foreground">
							Held
						</Badge>
					) : (
						<AlertSeverityBadge severity={incident.severity} />
					)}
					<Link
						to="/alerts/incidents/$incidentId"
						params={{ incidentId: incident.id }}
						className={cn("min-w-0 truncate font-medium", ROW_STRETCHED_LINK_CLASS)}
						title={incidentTitle(incident)}
					>
						{held ? `${incident.ruleName}: waiting on data` : incidentTitle(incident)}
					</Link>
				</div>
				<p className="truncate text-xs text-muted-foreground">
					{incident.ruleName}
					{incident.groupKey !== null && ` · ${incident.groupKey}`}
				</p>
			</div>
			<span className="font-mono text-xs tabular-nums">
				{held ? (
					<span className="text-muted-foreground">no data</span>
				) : (
					<span
						className={
							incident.severity === "critical" ? "text-severity-error" : "text-severity-warn"
						}
					>
						{formatSignalValue(incident.signalType, incident.lastObservedValue)}
					</span>
				)}
				<span className="text-muted-foreground">
					{" / "}
					{formatSignalValue(incident.signalType, incident.threshold)}
				</span>
			</span>
			<span className="font-mono text-xs tabular-nums">
				{formatAlertDuration(incident.firstTriggeredAt, null)}
			</span>
		</li>
	)
}

/* ── Last 24 hours ──────────────────────────────────────────────────────── */

const MAX_LANES = 8

function FireStrip({
	lanes,
	incidents,
	range,
	enabledRuleIds,
}: {
	lanes: ReadonlyArray<FireLane>
	incidents: ReadonlyArray<AlertIncidentDocument>
	range: { readonly min: number; readonly max: number }
	/** Enabled rules only: a disabled rule is not "quiet", it is off. */
	enabledRuleIds: ReadonlyArray<string>
}) {
	const inWindow = incidents.filter((i) => Date.parse(i.firstTriggeredAt) >= range.min)
	const resolved = inWindow.filter((i) => i.resolvedAt !== null)
	const mttr =
		resolved.length === 0
			? EMPTY_VALUE
			: formatResolutionDuration(
					resolved.reduce(
						(sum, i) =>
							sum +
							(Date.parse(i.resolvedAt ?? i.firstTriggeredAt) - Date.parse(i.firstTriggeredAt)),
						0,
					) / resolved.length,
				)
	const shown = lanes.slice(0, MAX_LANES)
	const fired = new Set(lanes.map((lane) => lane.ruleId))
	const quiet = enabledRuleIds.filter((id) => !fired.has(id)).length
	const hiddenFired = lanes.length - shown.length
	const footer = [
		hiddenFired > 0 ? `+ ${hiddenFired} more fired` : null,
		quiet > 0 ? countLabel(quiet, "quiet rule") : null,
	]
		.filter((part) => part !== null)
		.join(" · ")
	const span = range.max - range.min

	return (
		<section className="space-y-3">
			<div className="flex items-baseline justify-between gap-4">
				<Eyebrow as="h3">Last 24 hours</Eyebrow>
				<span className="font-mono text-xs text-muted-foreground">
					{countLabel(inWindow.length, "incident")} · MTTR {mttr} ·{" "}
					{countLabel(lanes.length, "rule")} fired
				</span>
			</div>
			{shown.length === 0 ? (
				<p className="border-t py-4 text-sm text-muted-foreground">
					No rule fired in the last 24 hours.
				</p>
			) : (
				<ul className="divide-y border-y">
					{shown.map((lane) => (
						<li
							key={lane.ruleId}
							className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-center gap-4 py-2"
						>
							<Link
								to="/alerts/$ruleId"
								params={{ ruleId: lane.ruleId }}
								className="truncate text-sm hover:underline"
								title={lane.ruleName}
							>
								{lane.ruleName}
							</Link>
							<div className="relative h-2.5 rounded-xs bg-muted/60">
								{lane.bars.map((bar) => (
									<span
										key={bar.id}
										className={cn(
											"absolute inset-y-0 rounded-xs",
											bar.held
												? "bg-muted-foreground/60"
												: bar.severity === "critical"
													? "bg-severity-error"
													: "bg-severity-warn",
											!bar.open && "opacity-70",
										)}
										style={{
											left: `${bar.start * 100}%`,
											width: `${(bar.end - bar.start) * 100}%`,
										}}
									/>
								))}
							</div>
						</li>
					))}
				</ul>
			)}
			<div className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-4 font-mono text-2xs text-muted-foreground">
				<span>{footer}</span>
				<div className="flex justify-between">
					<span>{Math.round(span / HOUR_MS)}h ago</span>
					<span>{Math.round(span / HOUR_MS / 2)}h ago</span>
					<span>Now</span>
				</div>
			</div>
		</section>
	)
}

/* ── Blind spots ────────────────────────────────────────────────────────── */

const BLIND_SPOT_META: Record<BlindSpotKind, { label: string; action: string; className: string }> = {
	error: { label: "Error", action: "Fix", className: "text-severity-error" },
	stale: { label: "Stale", action: "Check", className: "text-severity-warn" },
	"no-data": { label: "No data", action: "Tune", className: "text-muted-foreground" },
	unrouted: { label: "Unrouted", action: "Route", className: "text-muted-foreground" },
	delivery: { label: "Delivery", action: "Check", className: "text-severity-warn" },
} satisfies Record<BlindSpotKind, { label: string; action: string; className: string }>

function BlindSpotsList({ spots }: { spots: ReadonlyArray<BlindSpot> }) {
	return (
		<section className="space-y-3">
			<div className="flex items-baseline justify-between gap-4">
				<Eyebrow as="h3">Blind spots</Eyebrow>
				<span className="font-mono text-xs text-muted-foreground">
					rules that can't fire or notify
				</span>
			</div>
			{spots.length === 0 ? (
				<p className="border-t py-4 text-sm text-muted-foreground">
					Every enabled rule is evaluating and routed somewhere.
				</p>
			) : (
				<ul className="divide-y border-t">
					{spots.map((spot) => {
						const meta = BLIND_SPOT_META[spot.kind]
						return (
							<li
								key={spot.rule.id}
								className="relative grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-4 py-2.5 hover:bg-muted/40"
							>
								<span className={cn("font-mono text-xs", meta.className)}>{meta.label}</span>
								<div className="min-w-0">
									<p className="truncate text-sm">{spot.rule.name}</p>
									<p className="truncate text-xs text-muted-foreground" title={spot.detail}>
										{spot.detail}
									</p>
								</div>
								<Link
									to="/alerts/$ruleId"
									params={{ ruleId: spot.rule.id }}
									className={cn(
										"text-xs font-medium text-primary",
										ROW_STRETCHED_LINK_CLASS,
									)}
								>
									{meta.action}
								</Link>
							</li>
						)
					})}
				</ul>
			)}
		</section>
	)
}
