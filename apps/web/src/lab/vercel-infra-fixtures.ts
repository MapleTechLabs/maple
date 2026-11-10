// Fixture rows for the /infra/vercel lab frames: four projects (one erroring, one with no traces,
// one forwarded but silent), AI Gateway usage across three models, team builds, one project's
// detail, functions and dependencies, and Speed Insights, Web Analytics and audit log readings.

import {
	VercelAiGatewayResponse,
	VercelDeploymentSummary,
	VercelSpeedInsightsResponse,
	VercelWebAnalyticsResponse,
	VercelDrainStatus,
	VercelInfraProjectDetailResponse,
	VercelIntegrationStatus,
	VercelProjectStatus,
	VercelTeam,
	type VercelAiGatewayBucket,
	type VercelAuditEvent,
	type VercelInfraDependency,
	type VercelInfraFunction,
	type VercelInfraProject,
	type VercelInfraRequestBucket,
} from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"

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
		projectId: `prj_${Str.split(id, "-")[0]}`,
		url: `${id}.vercel.app`,
		target,
		state,
		branch,
		commitSha: `${Str.replace(/\W/g, "")(id)}9f3c2a1b7d`,
		commitMessage,
		creator: "rmoreau",
		createdAt: NOW - ageMs,
		buildingAt: state === "QUEUED" ? null : NOW - ageMs + 4_000,
		// A failed build is ready when it stopped.
		readyAt: state === "READY" ? NOW - ageMs + 94_000 : state === "ERROR" ? NOW - ageMs + 41_000 : null,
		errorCode: state === "ERROR" ? "BUILD_FAILED" : null,
		errorMessage: state === "ERROR" ? 'Command "vite build" exited with 1' : null,
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
	aiGatewayEnabled: true,
	speedInsightsEnabled: false,
	webAnalyticsEnabled: false,
	auditLogEnabled: false,
	drains: {
		logs: new VercelDrainStatus({ id: "drn_logs", status: "enabled", lastError: null }),
		traces: new VercelDrainStatus({ id: "drn_traces", status: "enabled", lastError: null }),
		aiGateway: new VercelDrainStatus({ id: "drn_ai_gateway", status: "enabled", lastError: null }),
		speedInsights: null,
		webAnalytics: null,
		auditLog: null,
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
	invocations = 0,
	coldStarts = 0,
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
	invocations,
	coldStarts,
})

/** `admin` is forwarded and silent: it has no row. */
export const VERCEL_PROJECTS: ReadonlyArray<VercelInfraProject> = [
	infraProject(
		"prj_storefront",
		"storefront",
		1_284_000,
		0.002,
		702_000,
		980_000,
		214,
		182,
		412_000,
		2_900,
	),
	infraProject("prj_api", "api", 642_000, 0.064, 0, 0, 3_120, 412, 640_000, 38_400),
	infraProject("prj_docs", "docs", 211_000, 0, 198_000, 205_000, 0, null),
]

/** A traces-only connection: projects arrive with latency and no request counts. */
export const VERCEL_TRACES_ONLY_STATUS = new VercelIntegrationStatus({
	...VERCEL_STATUS,
	logsEnabled: false,
	drains: { ...VERCEL_STATUS.drains, logs: null },
})
export const VERCEL_TRACES_ONLY_PROJECTS: ReadonlyArray<VercelInfraProject> = [
	infraProject("prj_storefront", "", 0, 0, 0, 0, 0, 182),
	infraProject("prj_api", "", 0, 0, 0, 0, 0, 412),
]

/** What a failed warehouse read hands `ErrorState`. */
export const VERCEL_READ_FAILURE = { message: "The warehouse didn't answer in time." }

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
	Arr.reduce(VERCEL_AI_TIMESERIES, 0, (total, row) => total + pick(row))

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
	models: Arr.map(MODELS, ([model, provider, requests, costUsd, errorShare, p95DurationMs]) => ({
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
	paths: Arr.map(
		[
			["/api/checkout", 212_000, 0.004, 0.21],
			["/api/cart", 164_000, 0.002, 0.08],
			["/api/products/[id]", 121_000, 0.11, 0.0],
			["/api/search", 88_000, 0.001, 0.62],
			["/api/webhooks/stripe", 31_000, 0.024, 0],
			["/api/health", 26_000, 0, 0.99],
		],
		([path, requests, share5xx, cached]) => ({
			path: String(path),
			requests: Number(requests),
			requests4xx: Math.round(Number(requests) * 0.015),
			requests5xx: Math.round(Number(requests) * Number(share5xx)),
			// `cached` is the hit rate over cache lookups; a path Vercel never caches reports no lookups.
			cacheHits: Math.round(Number(requests) * 0.9 * Number(cached)),
			cacheLookups: Number(cached) === 0 ? 0 : Math.round(Number(requests) * 0.9),
		}),
	),
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

/** Every drain on: the overview's Speed Insights, Web Analytics and audit log sections read. */
export const VERCEL_ALL_DRAINS_STATUS = new VercelIntegrationStatus({
	...VERCEL_STATUS,
	speedInsightsEnabled: true,
	webAnalyticsEnabled: true,
	auditLogEnabled: true,
	drains: {
		...VERCEL_STATUS.drains,
		speedInsights: new VercelDrainStatus({ id: "drn_speed", status: "enabled", lastError: null }),
		webAnalytics: new VercelDrainStatus({ id: "drn_web", status: "enabled", lastError: null }),
		auditLog: new VercelDrainStatus({ id: "drn_audit", status: "enabled", lastError: null }),
	},
})

/** The team's newest builds across projects, one failed. */
export const VERCEL_TEAM_DEPLOYMENTS: ReadonlyArray<VercelDeploymentSummary> = [
	deployment("admin-q4", "ERROR", "feat/audit-log", "Audit log table", 40 * MINUTE, null),
	deployment("storefront-k2", "READY", "main", "Checkout: retry card tokenization", 3 * HOUR),
	...VERCEL_API_DEPLOYMENTS,
]

export const VERCEL_FUNCTIONS: ReadonlyArray<VercelInfraFunction> = [
	{
		route: "/api/checkout",
		invocations: 212_000,
		coldStarts: 4_100,
		p95DurationMs: 640,
		initP50Ms: 820,
		initP95Ms: 1_480,
	},
	{
		route: "/api/products/[id]",
		invocations: 121_000,
		coldStarts: 18_200,
		p95DurationMs: 1_900,
		initP50Ms: 1_240,
		initP95Ms: 2_960,
	},
	{
		route: "/api/search",
		invocations: 88_000,
		coldStarts: 900,
		p95DurationMs: 310,
		initP50Ms: 610,
		initP95Ms: 990,
	},
	{
		route: "/api/health",
		invocations: 26_000,
		coldStarts: 0,
		p95DurationMs: 12,
		initP50Ms: null,
		initP95Ms: null,
	},
]

export const VERCEL_DEPENDENCIES: ReadonlyArray<VercelInfraDependency> = [
	{ host: "api.stripe.com", calls: 214_000, errors: 860, p50DurationMs: 182, p95DurationMs: 640 },
	{ host: "ai-gateway.vercel.sh", calls: 14_900, errors: 220, p50DurationMs: 920, p95DurationMs: 3_100 },
	{ host: "db.acme.internal", calls: 512_000, errors: 0, p50DurationMs: 4, p95DurationMs: 22 },
]

const reading = (key: string, metric: string, p75: number, samples: number) => ({ key, metric, p75, samples })

/** The team's p75s: LCP needs improvement, CLS is poor. */
export const VERCEL_SPEED_INSIGHTS = new VercelSpeedInsightsResponse({
	metrics: [
		reading("", "LCP", 2_840, 18_200),
		reading("", "INP", 160, 9_400),
		reading("", "CLS", 0.31, 17_900),
		reading("", "FCP", 1_420, 18_200),
		reading("", "TTFB", 610, 18_200),
	],
	routes: [],
	devices: [],
})

/** One project's read adds routes and devices. */
export const VERCEL_PROJECT_SPEED_INSIGHTS = new VercelSpeedInsightsResponse({
	metrics: VERCEL_SPEED_INSIGHTS.metrics,
	routes: [
		reading("/", "LCP", 2_210, 9_800),
		reading("/", "INP", 140, 5_100),
		reading("/", "CLS", 0.04, 9_600),
		reading("/products/[slug]", "LCP", 4_420, 6_100),
		reading("/products/[slug]", "CLS", 0.38, 6_000),
		reading("/checkout", "INP", 540, 1_200),
		reading("/checkout", "TTFB", 1_920, 1_300),
	],
	devices: [
		reading("desktop", "LCP", 1_980, 7_400),
		reading("desktop", "INP", 110, 3_900),
		reading("mobile", "LCP", 3_610, 10_800),
		reading("mobile", "INP", 230, 5_500),
	],
})

export const VERCEL_EMPTY_SPEED_INSIGHTS = new VercelSpeedInsightsResponse({
	metrics: [],
	routes: [],
	devices: [],
})

const top = (value: string, count: number, devices: number) => ({ value, count, devices })

export const VERCEL_WEB_ANALYTICS = new VercelWebAnalyticsResponse({
	summary: { pageViews: 184_200, uniqueDevices: 41_800, customEvents: 3_120 },
	pages: [
		top("/", 61_400, 22_100),
		top("/pricing", 18_900, 9_400),
		top("/docs/getting-started", 12_300, 6_800),
	],
	referrers: [top("https://google.com", 42_100, 14_900), top("https://news.ycombinator.com", 6_200, 4_900)],
	countries: [top("US", 71_000, 15_200), top("DE", 22_400, 5_100), top("GB", 14_900, 3_900)],
	events: [top("Signup", 1_840, 1_790), top("Checkout started", 1_280, 1_010)],
})

export const VERCEL_EMPTY_WEB_ANALYTICS = new VercelWebAnalyticsResponse({
	summary: { pageViews: 0, uniqueDevices: 0, customEvents: 0 },
	pages: [],
	referrers: [],
	countries: [],
	events: [],
})

export const VERCEL_AUDIT_LOG: ReadonlyArray<VercelAuditEvent> = [
	{
		timestamp: new Date(NOW - 12 * MINUTE).toISOString(),
		action: "project.env-variable.updated",
		actor: "Rosa Moreau",
		actorType: "user",
		projectId: "prj_api",
	},
	{
		timestamp: new Date(NOW - 3 * HOUR).toISOString(),
		action: "drain-created",
		actor: "Maple",
		actorType: "app",
		projectId: "",
	},
	{
		timestamp: new Date(NOW - 26 * HOUR).toISOString(),
		action: "team.member.added",
		actor: "Sam Okafor",
		actorType: "user",
		projectId: "",
	},
]
