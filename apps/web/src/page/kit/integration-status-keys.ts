import { type RequestKey, requestKey } from "@maple/views/data/request-key"

// One cache key per integration status read: `/integrations` and the provider pages share each read.

export const INTEGRATION_STATUS_OPERATION = {
	cloudflare: "integrations.cloudflareStatus",
	railway: "integrations.railwayStatus",
	vercel: "integrations.vercelStatus",
	planetscale: "planetscaleIntegration.status",
	planetscaleDatabases: "planetscaleIntegration.databases",
	gcp: "gcpIntegration.status",
	aws: "awsIntegration.status",
	supabase: "integrations.supabaseStatus",
	linear: "integrations.linearStatus",
	github: "integrations.githubStatus",
	searchConsole: "integrations.searchConsoleStatus",
	chat: "chatIntegration.connectors",
	scrapeTargets: "scrapeTargets.list",
	dataSources: "dataSources.list",
} as const

export type IntegrationStatusRead = keyof typeof INTEGRATION_STATUS_OPERATION

export const integrationStatusKey = (orgId: string, read: IntegrationStatusRead): RequestKey =>
	requestKey(orgId, INTEGRATION_STATUS_OPERATION[read], {})
