import { useState } from "react"

import type { V2GcpConnector } from "@maple/domain/http/v2"

import { GcpLogFilterField, GcpTerraformSteps } from "@/components/integrations/gcp-configure"
import { gcpLogFilterChoice, type GcpLogFilterDraft } from "@/components/integrations/gcp-connector-state"
import { DashboardLayout } from "@/components/layout/dashboard-layout"

const SCENARIOS = [
	{
		title: "New connection",
		description: "No sink yet: platform logs only, until OpenTelemetry is ruled out.",
		sinkExists: false,
		initial: { keep: null, runtimes: null },
	},
	{
		title: "New connection, OpenTelemetry ruled out",
		description: "After “Can't forward via OpenTelemetry”, with Cloud Run ticked.",
		sinkExists: false,
		initial: { keep: null, runtimes: ["cloud_run"] },
	},
	{
		title: "Existing sink, keep",
		description: "Configure on a connection whose sink exists: its filter is left alone.",
		sinkExists: true,
		initial: { keep: null, runtimes: null },
	},
	{
		title: "Existing sink, replace",
		description: "Configure with Replace filter chosen.",
		sinkExists: true,
		initial: { keep: false, runtimes: null },
	},
] as const satisfies ReadonlyArray<{
	title: string
	description: string
	sinkExists: boolean
	initial: GcpLogFilterDraft
}>

const CONNECTOR: V2GcpConnector = {
	id: "gcpc_01J9ZQ3W1V5X8Y2B4C6D7E8F9G" as V2GcpConnector["id"],
	object: "gcp_connector",
	scope_type: "organization",
	scope_id: "123456789012",
	project_id: "acme-host",
	logs_enabled: true,
	metrics_enabled: false,
	created_at: "2026-10-15T09:00:00.000Z",
	last_log_received_at: null,
	last_log_error: null,
	applied_logs_enabled: null,
	applied_metrics_enabled: null,
	setup_reported_at: null,
	last_metrics_received_at: null,
	last_metrics_error: null,
	discovered_project_count: null,
	last_resources_error: null,
}

const TERRAFORM = `# Maple connection for Google Cloud organization 123456789012. It holds no secret.
# What it creates: https://github.com/MapleTechLabs/maple/tree/terraform-google-maple-v1.0.0/deploy/terraform-google-maple
module "maple_gcp_123456789012" {
  source = "github.com/MapleTechLabs/maple//deploy/terraform-google-maple?ref=terraform-google-maple-v1.0.0"

  connector_id          = "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
  scope_type            = "organization"
  scope_id              = "123456789012"
  project_id            = "acme-host"
  push_endpoint         = "https://ingest.maple.dev/v1/logpush/gcp/018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
  maple_service_account = "maple@maple-prd.iam.gserviceaccount.com"
  logs_enabled          = true
  log_filter            = "NOT log_id(\\"cloudaudit.googleapis.com/data_access\\") AND NOT httpRequest.userAgent:\\"GoogleHC\\""
}
`

const TERRAFORM_SCENARIOS = [
	{
		title: "Terraform, before the apply",
		description: "Nothing confirmed yet: logs wait for a signed push, access for a check.",
		connector: {},
		replacesFilter: false,
	},
	{
		title: "Terraform over a script-made sink",
		description: "The sink exists and its filter was kept: Terraform replaces it.",
		connector: { applied_logs_enabled: true },
		replacesFilter: true,
	},
	{
		title: "Terraform, confirmed",
		description: "A signed push arrived and the access check passed.",
		connector: { applied_logs_enabled: true, applied_metrics_enabled: true },
		replacesFilter: false,
	},
] as const satisfies ReadonlyArray<{
	title: string
	description: string
	connector: Partial<V2GcpConnector>
	replacesFilter: boolean
}>

/**
 * The Google Cloud configuration's Log filter over plain component state, in each place it shows up.
 * Each card prints what the setup script would be asked for, so a click can be checked against it.
 */
export function GcpLab() {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }, { label: "Google Cloud configuration" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-4">
							{SCENARIOS.map((scenario) => (
								<Scenario key={scenario.title} {...scenario} />
							))}
							{TERRAFORM_SCENARIOS.map((scenario) => (
								<section key={scenario.title} className="flex flex-col gap-3">
									<div>
										<h2 className="text-sm font-medium">{scenario.title}</h2>
										<p className="text-xs text-muted-foreground">
											{scenario.description}
										</p>
									</div>
									<div className="rounded-xl border bg-popover p-6">
										<GcpTerraformSteps
											connector={{ ...CONNECTOR, ...scenario.connector }}
											metricsAvailable
											terraform={TERRAFORM}
											failure={null}
											replacesFilter={scenario.replacesFilter}
											whoRuns={
												<>
													<span className="text-foreground">Owner</span> of the host
													project{" "}
													<span className="font-mono text-foreground">
														acme-host
													</span>
												</>
											}
										/>
									</div>
								</section>
							))}
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}

function Scenario({
	title,
	description,
	sinkExists,
	initial,
}: {
	title: string
	description: string
	sinkExists: boolean
	initial: GcpLogFilterDraft
}) {
	const [filter, setFilter] = useState<GcpLogFilterDraft>(initial)
	const { applicationLogs } = gcpLogFilterChoice(filter, sinkExists)
	return (
		<section className="flex flex-col gap-3">
			<div>
				<h2 className="text-sm font-medium">{title}</h2>
				<p className="text-xs text-muted-foreground">{description}</p>
			</div>
			<div className="rounded-xl border bg-popover p-6">
				<GcpLogFilterField
					sinkExists={sinkExists}
					filter={filter}
					onFilter={setFilter}
					logRouter={sinkExists ? "https://console.cloud.google.com/logs/router" : undefined}
				/>
			</div>
			<p className="font-mono text-xs text-muted-foreground">
				application_logs:{" "}
				{applicationLogs === undefined
					? "omitted (keep the filter)"
					: JSON.stringify(applicationLogs)}
			</p>
		</section>
	)
}
