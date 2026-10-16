import { Schema } from "effect"
import { V2GcpConnector } from "@maple/domain/http/v2"

import { GcpConnection } from "@/components/integrations/gcp-integration-card"
import { DashboardLayout } from "@/components/layout/dashboard-layout"

const NOW = Date.now()
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

/** A project connection whose script ran an hour ago and that delivers both. */
const connector = (over: Partial<typeof V2GcpConnector.Encoded> = {}): V2GcpConnector =>
	Schema.decodeUnknownSync(V2GcpConnector)({
		id: "gcpc_YofPTrK9782DWwcnXhpcCw",
		object: "gcp_connector",
		scope_type: "project",
		scope_id: "maple-development-project",
		project_id: "maple-development-project",
		logs_enabled: true,
		metrics_enabled: true,
		created_at: ago(90),
		last_log_received_at: ago(1),
		last_log_error: null,
		applied_logs_enabled: true,
		applied_metrics_enabled: true,
		setup_reported_at: ago(60),
		last_metrics_received_at: ago(4),
		last_metrics_error: null,
		discovered_project_count: 1,
		last_resources_error: null,
		...over,
	})

const SCENARIOS: ReadonlyArray<{ title: string; connector: V2GcpConnector }> = [
	{ title: "Healthy project", connector: connector() },
	{
		title: "Healthy folder",
		connector: connector({
			scope_type: "folder",
			scope_id: "482910374615",
			project_id: "maple-shared-logging",
			discovered_project_count: 13,
			last_log_received_at: ago(0.2),
			last_metrics_received_at: ago(2),
		}),
	},
	{
		title: "Waiting for the first data",
		connector: connector({
			setup_reported_at: ago(3),
			last_log_received_at: null,
			last_metrics_received_at: null,
		}),
	},
	{
		title: "Overdue",
		connector: connector({
			setup_reported_at: ago(24),
			last_log_received_at: null,
			last_metrics_received_at: null,
		}),
	},
	{
		title: "Log forwarding failing",
		connector: connector({
			last_log_received_at: ago(120),
			last_log_error:
				"The log sink can't publish to Maple's topic. Run the setup script again: it restores the permission. Google answered: PERMISSION_DENIED: pubsub.topics.publish.",
			last_metrics_received_at: ago(2),
		}),
	},
	{
		title: "Setup pending",
		connector: connector({
			applied_logs_enabled: null,
			applied_metrics_enabled: null,
			setup_reported_at: null,
			last_log_received_at: null,
			last_metrics_received_at: null,
		}),
	},
]

/** Each state of a Google Cloud connection over fixture data, as an admin sees it. */
export function GcpConnectionsLab() {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }, { label: "Google Cloud connections" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 font-display">
							{SCENARIOS.map((scenario) => (
								<section key={scenario.title} className="flex flex-col gap-2">
									<h2 className="text-xs text-muted-foreground">{scenario.title}</h2>
									<GcpConnection
										connector={scenario.connector}
										isAdmin
										nowMs={NOW}
										onConfigure={() => undefined}
										onRemoved={() => undefined}
									/>
								</section>
							))}
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
