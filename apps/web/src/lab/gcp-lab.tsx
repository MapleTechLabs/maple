import { useState } from "react"

import { GcpLogFilterField } from "@/components/integrations/gcp-configure"
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

/**
 * The Google Cloud configuration's Log filter over plain component state, in each place it shows up.
 * Each card prints what the setup script would be asked for, so a click can be checked against it.
 */
export function GcpLab() {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }, { label: "Google Cloud log filter" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-4">
							{SCENARIOS.map((scenario) => (
								<Scenario key={scenario.title} {...scenario} />
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
