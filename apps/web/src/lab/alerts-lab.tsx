import { useMemo, useState, type ReactNode } from "react"

import type { AlertDestinationType } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { cn } from "@maple/ui/lib/utils"

import { PROVIDERS } from "@/components/alerts/destination-provider"
import { IncidentBody, IncidentHeader } from "@/components/alerts/incident-detail/incident-detail-view"
import { DestinationRow, DESTINATION_ROW_GRID, HEALTH_WINDOW } from "@/components/alerts/overview/destination-row"
import { InboxTab } from "@/components/alerts/overview/inbox-tab"
import { RulesTab } from "@/components/alerts/overview/rules-tab"
import { UnderlineTabStrip, underlineTabClass } from "@/components/common/underline-link-tabs"
import { PlusIcon } from "@/components/icons"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { buildIncidentTimeline } from "@/lib/alerts/incident-timeline"
import type { RuleBucket } from "@/lib/alerts/overview-derive"
import type { AlertsOverviewReady } from "@/lib/models/alerts-overview-model"
import { type AlertsLabFixture, buildAlertsLabFixture } from "@/lab/alerts-fixture"

/**
 * The `/alerts` tabs and the incident page over one fixture org, with no API
 * and no session. Each section renders at a desktop content width inside the
 * page's own tab chrome, so it screenshots like the product.
 */

const FRAME_WIDTH = 1200
const destinationTypeLabel = (type: AlertDestinationType) => PROVIDERS[type].label
const noop = () => undefined

type AlertsTab = "inbox" | "rules" | "routing"

export function AlertsLab() {
	const [nowMs] = useState(() => Date.now())
	const fixture = useMemo(() => buildAlertsLabFixture(nowMs), [nowMs])
	const [status, setStatus] = useState<RuleBucket | undefined>(undefined)

	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }, { label: "Alerts" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="space-y-12">
							<LabSection id="inbox" title="Inbox: two firing, one held">
								<AlertsFrame tab="inbox" data={fixture.overview}>
									<InboxTab
										data={fixture.overview}
										destinations={fixture.destinations}
										isAdmin
										serviceName={undefined}
									/>
								</AlertsFrame>
							</LabSection>

							<LabSection id="inbox-quiet" title="Inbox: nothing firing, two blind spots">
								<AlertsFrame tab="inbox" data={fixture.quiet}>
									<InboxTab
										data={fixture.quiet}
										destinations={fixture.destinations}
										isAdmin
										serviceName={undefined}
									/>
								</AlertsFrame>
							</LabSection>

							<LabSection id="rules" title="Rules">
								<AlertsFrame tab="rules" data={fixture.overview}>
									<RulesTab
										data={fixture.overview}
										destinations={fixture.destinations}
										isAdmin
										serviceName={undefined}
										status={status}
										onStatusChange={setStatus}
										isToggling={false}
										toggleFailed={false}
										onToggleRule={noop}
									/>
								</AlertsFrame>
							</LabSection>

							<LabSection id="routing" title="Routing: destinations and delivery health">
								<AlertsFrame tab="routing" data={fixture.overview}>
									<RoutingDestinations fixture={fixture} />
								</AlertsFrame>
							</LabSection>

							<LabSection id="incident" title="Incident: critical error rate on maple-chat">
								<IncidentFrame fixture={fixture} nowMs={nowMs} />
							</LabSection>
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function LabSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
	return (
		<section id={id} className="scroll-mt-6 space-y-3">
			<h2 className="font-mono text-xs text-muted-foreground">
				#{id} <span className="text-foreground">{title}</span>
			</h2>
			{children}
		</section>
	)
}

const ALERTS_TABS: ReadonlyArray<{ value: AlertsTab; label: string }> = [
	{ value: "inbox", label: "Inbox" },
	{ value: "rules", label: "Rules" },
	{ value: "routing", label: "Routing" },
]

/** The `/alerts` header and tab strip around one tab's body, at a fixed desktop width. */
function AlertsFrame({
	tab,
	data,
	children,
}: {
	tab: AlertsTab
	data: AlertsOverviewReady
	children: ReactNode
}) {
	const counts = { inbox: data.openIncidents.length, rules: data.rules.length, routing: 0 }
	return (
		<div className="overflow-hidden rounded-md border bg-background" style={{ width: FRAME_WIDTH }}>
			<div className="space-y-3 border-b px-4 pt-4">
				<div className="flex items-center justify-between gap-4">
					<p className="text-sm font-medium">Alerts</p>
					<Button size="sm">
						<PlusIcon />
						{tab === "routing" ? "Add destination" : "New rule"}
					</Button>
				</div>
				<UnderlineTabStrip bleed={false} divided={false} label="Alerts sections">
					{ALERTS_TABS.map((entry) => (
						<span key={entry.value} className={underlineTabClass(entry.value === tab)}>
							{entry.label}
							{counts[entry.value] > 0 && (
								<span
									className={cn(
										"font-mono text-xs tabular-nums",
										entry.value === "inbox" ? "text-severity-error" : "text-muted-foreground",
									)}
								>
									{counts[entry.value]}
								</span>
							)}
						</span>
					))}
				</UnderlineTabStrip>
			</div>
			<div className="p-6">{children}</div>
		</div>
	)
}

/** The routing tab's destinations table; the live tab reads its rows from hooks. */
function RoutingDestinations({ fixture }: { fixture: AlertsLabFixture }) {
	return (
		<div className="overflow-x-auto rounded-md border">
			<div className="min-w-[760px]">
				<div className={cn(DESTINATION_ROW_GRID, "border-b px-4 py-2 text-xs text-muted-foreground")}>
					<span>Destination</span>
					<span>Type</span>
					<span>Last {HEALTH_WINDOW} attempts</span>
					<span className="text-right">Last delivered</span>
					<span />
				</div>
				<ul className="divide-y">
					{fixture.destinations.map((destination) => (
						<DestinationRow
							key={destination.id}
							destination={destination}
							recent={fixture.deliveries
								.filter((event) => event.destinationId === destination.id)
								.slice(0, HEALTH_WINDOW)}
							isAdmin
							isTesting={false}
							isDeleting={false}
							onToggle={noop}
							onTest={noop}
							onEdit={noop}
							onDelete={() => Promise.resolve(false)}
						/>
					))}
				</ul>
			</div>
		</div>
	)
}

function IncidentFrame({
	fixture,
	nowMs,
}: {
	fixture: AlertsLabFixture
	nowMs: number
}) {
	const { incident, rule, ruleIncidents, states, preview, range, deliveries, investigation } =
		fixture.incident
	const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
	const entries = useMemo(
		() =>
			buildIncidentTimeline({
				incident,
				deliveries,
				investigation,
				renotifyIntervalMinutes: rule.renotifyIntervalMinutes,
				destinationTypeLabel,
			}),
		[incident, deliveries, investigation, rule],
	)
	return (
		<div className="overflow-hidden rounded-md border bg-background" style={{ width: FRAME_WIDTH }}>
			<div className="border-b p-4">
				<IncidentHeader
					incident={incident}
					rule={rule}
					now={nowMs}
					timeZone={timeZone}
					investigationId={investigation.id}
					investigationPending={false}
					onInvestigate={noop}
				/>
			</div>
			<div className="p-6">
				<IncidentBody
					incident={incident}
					rule={rule}
					ruleIncidents={ruleIncidents}
					states={states}
					preview={preview}
					previewLoading={false}
					previewError={null}
					range={range}
					now={nowMs}
					timeZone={timeZone}
					entries={entries}
					entriesLoading={false}
					entriesFailed={false}
				/>
			</div>
		</div>
	)
}
