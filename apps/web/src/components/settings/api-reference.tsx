import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import { CopyableField } from "@maple/ui/components/ui/copyable-field"
import { Panel } from "@maple/ui/components/ui/panel"
import { ChevronRightIcon, CodeIcon } from "@/components/icons"
import { apiPublicUrl } from "@/lib/services/common/api-base-url"
import { SettingsSection } from "./settings-section"

/** Keep in sync with `SCOPE_FAMILIES` in create-api-key-dialog.tsx: one row per shipped v2 resource family. */
const SCOPE_FAMILY_ROWS = [
	{ id: "api_keys", label: "API keys", description: "Create, roll, and revoke API keys" },
	{ id: "dashboards", label: "Dashboards", description: "Dashboards, templates, and version history" },
	{
		id: "alerts",
		label: "Alerts",
		description: "Alert rules (incl. test/preview/checks), destinations, and incidents",
	},
	{ id: "ingest_keys", label: "Ingest keys", description: "View and roll telemetry ingest keys" },
	{
		id: "attribute_mappings",
		label: "Attribute mappings",
		description: "Ingest-time attribute rewrite rules",
	},
	{
		id: "scrape_targets",
		label: "Scrape targets",
		description: "Prometheus/PlanetScale scrape targets, probes, and checks",
	},
	{ id: "instrumentation", label: "Recommendations", description: "Instrumentation recommendations" },
	{
		id: "investigations",
		label: "Investigations",
		description: "AI investigation war-rooms: list, open, and update status",
	},
	{
		id: "anomalies",
		label: "Anomalies",
		description: "Anomaly incidents (incl. timeseries/resolve/link-issue) and detector settings",
	},
	{
		id: "session_replays",
		label: "Session replays",
		description: "Search sessions, retrieve detail, events, and transcripts",
	},
	{ id: "traces", label: "Traces", description: "Search traces and retrieve spans" },
	{ id: "logs", label: "Logs", description: "Search and retrieve log records" },
	{ id: "metrics", label: "Metrics", description: "Metric catalog and timeseries reads" },
	{ id: "services", label: "Services", description: "Service catalog and health summaries" },
	{ id: "service_map", label: "Service map", description: "Service-to-service topology" },
	{ id: "query", label: "Query", description: "Structured telemetry queries" },
	{ id: "organization", label: "Organization", description: "Read the organization's identity" },
	{ id: "audit_log", label: "Audit log", description: "Read the audit log (org admins only)" },
] as const

/** Where to point the keys above, and what each scope grants, folded away until needed. */
export function ApiReference() {
	return (
		<SettingsSection
			title="API reference"
			description="A REST interface with snake_case JSON, cursor-paginated lists and scoped API keys."
			width="wide"
			framed={false}
			actions={
				<Button
					size="sm"
					variant="outline"
					render={<a href={`${apiPublicUrl}/v2/docs`} target="_blank" rel="noopener noreferrer" />}
				>
					<CodeIcon data-icon="inline-start" />
					Open API reference
				</Button>
			}
		>
			<Panel className="divide-y">
				<div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
					<span className="text-muted-foreground w-20 shrink-0 text-xs">Base URL</span>
					<div className="min-w-0 max-w-md flex-1">
						<CopyableField value={`${apiPublicUrl}/v2`} copyLabel="Base URL" />
					</div>
				</div>
				<Collapsible>
					<CollapsibleTrigger className="group/scopes hover:bg-muted/20 flex w-full items-center gap-2 px-4 py-3 text-left">
						<ChevronRightIcon
							size={14}
							className="text-muted-foreground shrink-0 transition-transform group-data-[panel-open]/scopes:rotate-90"
						/>
						<span className="text-sm font-medium">Scopes</span>
						<span className="text-muted-foreground text-sm">
							{SCOPE_FAMILY_ROWS.length} resource families
						</span>
						<span className="flex-1" />
						<span className="text-muted-foreground hidden text-2xs md:block">
							Read or write per family. A key without scopes has full access.
						</span>
					</CollapsibleTrigger>
					<CollapsiblePanel className="divide-y border-t">
						{SCOPE_FAMILY_ROWS.map((family) => (
							<div
								key={family.id}
								className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2.5"
							>
								<div className="min-w-0 flex-1 space-y-0.5">
									<div className="text-sm">{family.label}</div>
									<div className="text-muted-foreground text-xs">{family.description}</div>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									<Badge variant="outline" mono className="text-2xs">
										{family.id}:read
									</Badge>
									<Badge variant="outline" mono className="text-2xs">
										{family.id}:write
									</Badge>
								</div>
							</div>
						))}
					</CollapsiblePanel>
				</Collapsible>
			</Panel>
		</SettingsSection>
	)
}
