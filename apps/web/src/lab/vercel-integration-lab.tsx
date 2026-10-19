import { useState } from "react"
import type React from "react"
import {
	VercelDeploymentSummary,
	VercelDrainStatus,
	VercelIntegrationStatus,
	VercelProjectStatus,
	VercelTeam,
	type VercelAiGatewayResponse,
	type VercelInfraProject,
	type VercelInfraRequestBucket,
} from "@maple/domain/http"
import { Panel } from "@maple/ui/components/ui/panel"

import { DashboardLayout } from "@/components/layout/dashboard-layout"
import {
	VercelTokenFields,
	VercelTeamFields,
	VercelSettingsFields,
} from "@/components/integrations/vercel-configure"
import {
	VercelConnectedView,
	VercelNotConnected,
	type VercelUsage,
} from "@/components/integrations/vercel-integration-card"
import { DEFAULT_VERCEL_DRAFT, type VercelDraft } from "@/components/integrations/vercel-model"
import { VERCEL_READ_FAILURE } from "./vercel-infra-fixtures"

const NOW = Date.now()
const minutesAgo = (minutes: number) => NOW - minutes * 60_000

const TEAM = new VercelTeam({ id: "team_9f2kLx", slug: "acme", name: "Acme" })

const deployment = (id: string, state: string, branch: string, minutes: number) =>
	new VercelDeploymentSummary({
		id,
		url: `${id}.vercel.app`,
		target: "production",
		state,
		branch,
		commitSha: "4be1c09f6a1d2e3b",
		commitMessage: "fix(checkout): retry the payment intent once",
		creator: "jdoe",
		createdAt: minutesAgo(minutes),
		readyAt: state === "READY" ? minutesAgo(minutes - 2) : null,
		inspectorUrl: `https://vercel.com/acme/${id}`,
	})

const project = (
	id: string,
	name: string,
	framework: string | null,
	production: VercelDeploymentSummary | null,
	forwarded = true,
) =>
	new VercelProjectStatus({
		id,
		name,
		framework,
		forwarded,
		productionDeployment: production,
		latestDeployment: production,
	})

const PROJECTS = [
	project("prj_web", "storefront", "nextjs", deployment("dpl_web", "READY", "main", 42)),
	project("prj_docs", "docs", "astro", deployment("dpl_docs", "READY", "main", 60 * 26)),
	project("prj_api", "edge-api", null, deployment("dpl_api", "ERROR", "feat/rate-limits", 12)),
	project("prj_admin", "admin", "nextjs", deployment("dpl_admin", "BUILDING", "main", 1)),
	project("prj_old", "legacy-landing", "gatsby", null, false),
]

// A deleted drain has no id left to show.
const drain = (status: VercelDrainStatus["status"], lastError: string | null = null) =>
	new VercelDrainStatus({ id: status === "missing" ? null : `drn_${status}_8sK2`, status, lastError })

const status = (over: Partial<ConstructorParameters<typeof VercelIntegrationStatus>[0]> = {}) =>
	new VercelIntegrationStatus({
		connected: true,
		team: TEAM,
		projectScope: "some",
		projectIds: ["prj_web", "prj_docs", "prj_api", "prj_admin"],
		samplingRate: 0.25,
		logsEnabled: true,
		tracesEnabled: true,
		drains: { logs: drain("enabled"), traces: drain("enabled") },
		projects: PROJECTS,
		authFailed: false,
		connectedAt: minutesAgo(60 * 24 * 3),
		lastSuccessAt: minutesAgo(3),
		lastError: null,
		...over,
	})

const usageRow = (
	projectId: string,
	requests: number,
	requests5xx: number,
	errorLogs: number,
): VercelInfraProject => ({
	projectId,
	projectName: projectId.slice(4),
	serviceName: projectId.slice(4),
	requests,
	requests4xx: Math.round(requests * 0.03),
	requests5xx,
	cacheHits: Math.round(requests * 0.6),
	cacheLookups: Math.round(requests * 0.9),
	errorLogs,
	lastSeen: new Date(minutesAgo(1)).toISOString(),
	p50DurationMs: 48,
	p95DurationMs: 310,
})

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

const BUCKETS: ReadonlyArray<VercelInfraRequestBucket> = HOURS.map((hour) => {
	const requests = 4200 + Math.round(2600 * Math.sin((hour / 24) * Math.PI * 2) ** 2)
	return {
		bucket: new Date(minutesAgo((24 - hour) * 60)).toISOString(),
		requests,
		requests2xx: Math.round(requests * 0.9),
		requests3xx: Math.round(requests * 0.06),
		requests4xx: Math.round(requests * 0.03),
		requests5xx: hour === 17 ? 140 : 6,
		cacheHits: Math.round(requests * 0.6),
		errorLogs: hour === 17 ? 90 : 3,
	}
})

const usage = (gatewayRequests: number): VercelUsage => {
	const gateway: VercelAiGatewayResponse = {
		summary: {
			requests: gatewayRequests,
			costUsd: gatewayRequests * 0.0042,
			inputTokens: gatewayRequests * 1800,
			outputTokens: gatewayRequests * 420,
			errors: Math.round(gatewayRequests * 0.01),
			p50DurationMs: 900,
			p95DurationMs: 4100,
		},
		models: [],
		projects: [],
		timeseries: HOURS.map((hour) => ({
			bucket: new Date(minutesAgo((24 - hour) * 60)).toISOString(),
			requests: gatewayRequests / 24,
			costUsd: (gatewayRequests / 24) * 0.0042 * (1 + (hour % 5) / 4),
			inputTokens: 0,
			outputTokens: 0,
			errors: 0,
		})),
	}
	return {
		projects: [
			usageRow("prj_web", 98_400, 12, 40),
			usageRow("prj_docs", 21_300, 0, 0),
			usageRow("prj_api", 14_900, 211, 380),
		],
		buckets: BUCKETS,
		gateway,
		error: null,
		retry: () => undefined,
	}
}

const SCENARIOS: ReadonlyArray<{ title: string; status: VercelIntegrationStatus; usage: VercelUsage }> = [
	{ title: "Connected, healthy", status: status(), usage: usage(3120) },
	{
		title: "Logs drain deleted on Vercel",
		status: status({ drains: { logs: drain("missing"), traces: drain("enabled") } }),
		usage: usage(3120),
	},
	{
		title: "Traces drain failing",
		status: status({
			drains: {
				logs: drain("enabled"),
				traces: drain("errored", "Endpoint responded 401 Unauthorized"),
			},
		}),
		usage: usage(0),
	},
	{ title: "Token rejected", status: status({ authFailed: true }), usage: usage(3120) },
	{
		title: "Traces only",
		status: status({ logsEnabled: false, drains: { logs: null, traces: drain("enabled") } }),
		usage: usage(3120),
	},
	{
		title: "Just connected, first sync pending",
		status: status({
			lastSuccessAt: null,
			projects: [],
			projectScope: "all",
			projectIds: [],
			samplingRate: 1,
		}),
		usage: { projects: [], buckets: [], gateway: null, error: null, retry: () => undefined },
	},
	{
		title: "Usage reads failed",
		status: status(),
		usage: {
			projects: "failed",
			buckets: "failed",
			gateway: "failed",
			error: VERCEL_READ_FAILURE,
			retry: () => undefined,
		},
	},
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<h2 className="text-xs text-muted-foreground">{title}</h2>
			{children}
		</section>
	)
}

/** The connect dialog's steps, flat on the page so each can be looked at. */
function ConnectSteps() {
	const [token, setToken] = useState("vcp_2xK9mQ…")
	const [teamId, setTeamId] = useState<string | null>(TEAM.id)
	const [draft, setDraft] = useState<VercelDraft>({
		...DEFAULT_VERCEL_DRAFT,
		projectScope: "some",
		projectIds: ["prj_web"],
	})
	return (
		<div className="grid gap-4 lg:grid-cols-3">
			<Panel className="p-4">
				<VercelTokenFields token={token} onToken={setToken} error={null} />
			</Panel>
			<Panel className="p-4">
				<VercelTeamFields
					teams={[TEAM, new VercelTeam({ id: "team_2", slug: "acme-labs", name: "Acme Labs" })]}
					teamId={teamId}
					onTeam={setTeamId}
				/>
			</Panel>
			<Panel className="p-4">
				<VercelSettingsFields projects={PROJECTS} draft={draft} onDraft={setDraft} />
			</Panel>
			<Panel className="p-4 lg:col-span-1">
				<VercelTokenFields
					token="vcp_expired"
					onToken={() => undefined}
					error="Vercel rejected the token: it has expired or was revoked."
				/>
			</Panel>
		</div>
	)
}

/** Every state of Integrations → Vercel over fixture data, as an admin sees it. */
export function VercelIntegrationLab() {
	return (
		<DashboardLayout.Root>
			<DashboardLayout.Breadcrumbs items={[{ label: "Lab" }, { label: "Vercel integration" }]} />
			<DashboardLayout.Body>
				<DashboardLayout.Content>
					<DashboardLayout.Scroll>
						<div className="@container/page mx-auto flex w-full max-w-6xl flex-col gap-8 p-4 font-display">
							<Section title="Not connected">
								<VercelNotConnected isAdmin onConnect={() => undefined} />
							</Section>
							<Section title="Connect: token, team, settings, token refused">
								<ConnectSteps />
							</Section>
							{SCENARIOS.map((scenario) => (
								<Section key={scenario.title} title={scenario.title}>
									<VercelConnectedView
										status={scenario.status}
										usage={scenario.usage}
										isAdmin
										onToken={() => undefined}
									/>
								</Section>
							))}
						</div>
					</DashboardLayout.Scroll>
				</DashboardLayout.Content>
			</DashboardLayout.Body>
		</DashboardLayout.Root>
	)
}
