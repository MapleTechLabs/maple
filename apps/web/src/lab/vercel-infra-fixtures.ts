// Fixture rows for the /infra/vercel lab frames: four projects (one erroring, one with no traces,
// one forwarded but silent), AI Gateway usage across three models, and one project's detail.

import {
	VercelAiGatewayResponse,
	VercelDeploymentSummary,
	VercelDrainStatus,
	VercelInfraProjectDetailResponse,
	VercelIntegrationStatus,
	VercelProjectStatus,
	VercelTeam,
	type VercelAiGatewayBucket,
	type VercelInfraProject,
	type VercelInfraRequestBucket,
} from "@maple/domain/http"

const NOW = Date.now()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const BUCKET_MS = 15 * MINUTE
const BUCKETS = 96

const deployment = (
	id: string,
	state: string,
	branch: string,
	commitMessage: string,
	ageMs: number,
	target: string | null = "production",
) =>
	new VercelDeploymentSummary({
		id,
		url: `${id}.vercel.app`,
		target,
		state,
		branch,
		commitSha: `${id.replace(/\W/g, "")}9f3c2a1b7d`,
		commitMessage,
		creator: "rmoreau",
		createdAt: NOW - ageMs,
		readyAt: state === "READY" ? NOW - ageMs + 90_000 : null,
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

export const VERCEL_STATUS = new VercelIntegrationStatus({
	connected: true,
	team: new VercelTeam({ id: "team_acme", slug: "acme", name: "Acme" }),
	projectScope: "all",
	projectIds: [],
	samplingRate: 1,
	logsEnabled: true,
	tracesEnabled: true,
	drains: {
		logs: new VercelDrainStatus({ id: "drn_logs", status: "enabled", lastError: null }),
		traces: new VercelDrainStatus({ id: "drn_traces", status: "enabled", lastError: null }),
	},
	projects: [
		project(
			"prj_storefront",
			"storefront",
			"nextjs",
			deployment("storefront-k2", "READY", "main", "Checkout: retry card tokenization", 3 * HOUR),
		),
		project(
			"prj_api",
			"api",
			"hono",
			deployment("api-x8", "READY", "main", "Move rate limits to the edge config", 26 * HOUR),
		),
		project(
			"prj_docs",
			"docs",
			"astro",
			deployment("docs-p1", "READY", "main", "Docs: AI Gateway setup page", 4 * 24 * HOUR),
		),
		project(
			"prj_admin",
			"admin",
			"vite",
			deployment("admin-q4", "ERROR", "feat/audit-log", "Audit log table", 40 * MINUTE),
		),
		project("prj_marketing", "marketing-legacy", "gatsby", null, false),
	],
	authFailed: false,
	connectedAt: NOW - 30 * 24 * HOUR,
	lastSuccessAt: NOW - 2 * MINUTE,
	lastError: null,
})

const infraProject = (
	projectId: string,
	projectName: string,
	requests: number,
	share5xx: number,
	cacheHits: number,
	cacheLookups: number,
	errorLogs: number,
	p95DurationMs: number | null,
): VercelInfraProject => ({
	projectId,
	projectName,
	serviceName: projectName,
	requests,
	requests4xx: Math.round(requests * 0.02),
	requests5xx: Math.round(requests * share5xx),
	cacheHits,
	cacheLookups,
	errorLogs,
	lastSeen: new Date(NOW - MINUTE).toISOString(),
	p50DurationMs: p95DurationMs === null ? null : p95DurationMs / 4,
	p95DurationMs,
})

/** `admin` is forwarded and silent: it has no row. */
export const VERCEL_PROJECTS: ReadonlyArray<VercelInfraProject> = [
	infraProject("prj_storefront", "storefront", 1_284_000, 0.002, 702_000, 980_000, 214, 182),
	infraProject("prj_api", "api", 642_000, 0.064, 0, 0, 3_120, 412),
	infraProject("prj_docs", "docs", 211_000, 0, 198_000, 205_000, 0, null),
]

const wave = (i: number, base: number) =>
	Math.round(base * (1 + 0.6 * Math.sin((i / BUCKETS) * Math.PI * 2 - 1.2)))
const bucketAt = (i: number) =>
	new Date(Math.floor((NOW - (BUCKETS - i) * BUCKET_MS) / BUCKET_MS) * BUCKET_MS).toISOString()

export const VERCEL_BUCKETS: ReadonlyArray<VercelInfraRequestBucket> = Array.from(
	{ length: BUCKETS },
	(_, i) => {
		const requests = wave(i, 22_000)
		const spike = i > 70 && i < 76 ? 0.08 : 0.004
		const requests5xx = Math.round(requests * spike)
		const requests4xx = Math.round(requests * 0.02)
		const requests3xx = Math.round(requests * 0.05)
		return {
			bucket: bucketAt(i),
			requests,
			requests2xx: requests - requests5xx - requests4xx - requests3xx - 12,
			requests3xx,
			requests4xx,
			requests5xx,
			cacheHits: Math.round(requests * 0.55),
			errorLogs: Math.round(requests5xx * 0.7) + 2,
		}
	},
)

const MODELS = [
	["anthropic/claude-sonnet-4.5", "anthropic", 18_400, 61.42, 0.004, 3_900],
	["openai/gpt-5-mini", "openai", 52_100, 18.07, 0.012, 1_450],
	["google/gemini-2.5-flash", "vertex", 9_800, 2.31, 0.031, 980],
] as const

export const VERCEL_AI_TIMESERIES: ReadonlyArray<VercelAiGatewayBucket> = Array.from(
	{ length: BUCKETS },
	(_, i) => {
		const requests = wave(i, 840)
		return {
			bucket: bucketAt(i),
			requests,
			costUsd: requests * 0.00098,
			inputTokens: requests * 1_900,
			outputTokens: requests * 420,
			errors: Math.round(requests * (i > 70 && i < 76 ? 0.06 : 0.008)),
		}
	},
)

const sum = (pick: (row: VercelAiGatewayBucket) => number) =>
	VERCEL_AI_TIMESERIES.reduce((total, row) => total + pick(row), 0)

export const VERCEL_AI_GATEWAY = new VercelAiGatewayResponse({
	summary: {
		requests: sum((row) => row.requests),
		costUsd: sum((row) => row.costUsd),
		inputTokens: sum((row) => row.inputTokens),
		outputTokens: sum((row) => row.outputTokens),
		errors: sum((row) => row.errors),
		p50DurationMs: 620,
		p95DurationMs: 3_100,
	},
	models: MODELS.map(([model, provider, requests, costUsd, errorShare, p95DurationMs]) => ({
		model,
		provider,
		requests,
		costUsd,
		inputTokens: requests * 1_900,
		outputTokens: requests * 420,
		errors: Math.round(requests * errorShare),
		p95DurationMs,
	})),
	projects: [
		{
			projectId: "prj_storefront",
			requests: 61_200,
			costUsd: 58.9,
			inputTokens: 116e6,
			outputTokens: 25e6,
			errors: 410,
		},
		{
			projectId: "prj_api",
			requests: 14_900,
			costUsd: 19.6,
			inputTokens: 28e6,
			outputTokens: 6e6,
			errors: 220,
		},
		{ projectId: "", requests: 4_200, costUsd: 3.3, inputTokens: 8e6, outputTokens: 1.7e6, errors: 31 },
	],
	timeseries: VERCEL_AI_TIMESERIES,
})

/** One project's read: the API leaves the by-project breakdown empty. */
export const VERCEL_API_AI_GATEWAY = new VercelAiGatewayResponse({
	summary: VERCEL_AI_GATEWAY.summary,
	models: VERCEL_AI_GATEWAY.models.slice(0, 2),
	projects: [],
	timeseries: VERCEL_AI_TIMESERIES,
})

export const VERCEL_EMPTY_AI_GATEWAY = new VercelAiGatewayResponse({
	summary: {
		requests: 0,
		costUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		errors: 0,
		p50DurationMs: null,
		p95DurationMs: null,
	},
	models: [],
	projects: [],
	timeseries: [],
})

export const VERCEL_API_DETAIL = new VercelInfraProjectDetailResponse({
	paths: [
		["/api/checkout", 212_000, 0.004, 0.21],
		["/api/cart", 164_000, 0.002, 0.08],
		["/api/products/[id]", 121_000, 0.11, 0.0],
		["/api/search", 88_000, 0.001, 0.62],
		["/api/webhooks/stripe", 31_000, 0.024, 0],
		["/api/health", 26_000, 0, 0.99],
	].map(([path, requests, share5xx, cached]) => ({
		path: String(path),
		requests: Number(requests),
		requests4xx: Math.round(Number(requests) * 0.015),
		requests5xx: Math.round(Number(requests) * Number(share5xx)),
		cacheHits: Math.round(Number(requests) * Number(cached)),
	})),
	errors: [
		{
			message: "Error: connect ETIMEDOUT 10.0.4.12:5432 at TCPConnectWrap.afterConnect",
			occurrences: 1_840,
			source: "lambda",
			lastSeen: new Date(NOW - 4 * MINUTE).toISOString(),
		},
		{
			message: "Task timed out after 10.02 seconds",
			occurrences: 612,
			source: "lambda",
			lastSeen: new Date(NOW - 18 * MINUTE).toISOString(),
		},
		{
			message: "TypeError: Cannot read properties of undefined (reading 'sku')",
			occurrences: 344,
			source: "edge",
			lastSeen: new Date(NOW - 2 * HOUR).toISOString(),
		},
	],
})

export const VERCEL_API_DEPLOYMENTS: ReadonlyArray<VercelDeploymentSummary> = [
	deployment("api-y2", "BUILDING", "feat/batch-writes", "Batch the order writes", 6 * MINUTE, null),
	deployment("api-x8", "READY", "main", "Move rate limits to the edge config", 26 * HOUR),
	deployment("api-w5", "ERROR", "fix/cold-start", "Lazy-load the PDF renderer", 30 * HOUR, null),
	deployment("api-v1", "READY", "main", "Products: cache the price table for 60s", 3 * 24 * HOUR),
]
