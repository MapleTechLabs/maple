import {
	GithubIntegrationStatus,
	SecurityAuditEventsResponse,
	SecurityAuditFindingsResponse,
	SecurityAuditRunDetail,
	SecurityAuditRunsResponse,
	SecurityAuditSettings,
	SecurityAuditTargetsResponse,
	SecurityAuditUnitsResponse,
} from "@maple/domain/http"
import { Schema } from "effect"

// Security Center fixtures for `/lab/security` and the page scene tests: four targets, one run in
// each state, findings of every verdict. Built relative to `now` so relative times read the same.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const TARGET_IDS = {
	gateway: "5ec0a0d1-0000-4000-8000-000000000001",
	dashboard: "5ec0a0d1-0000-4000-8000-000000000002",
	billing: "5ec0a0d1-0000-4000-8000-000000000003",
	terraform: "5ec0a0d1-0000-4000-8000-000000000004",
} as const

export const RUN_IDS = {
	gateway: "run_9f3c2a1e7b",
	dashboard: "run_7c1e04b2aa",
	billing: "run_a20f9d63c1",
	terraform: "run_e41b77d012",
	billingCancelled: "run_51be0c9f44",
} as const

const target = (
	id: string,
	repository: string,
	branch: string,
	profile: "deep" | "quick",
	scopePaths: ReadonlyArray<string>,
	now: number,
) => ({
	id,
	repository,
	branch,
	enabled: true,
	profile,
	scopePaths,
	// The quick billing audit hunts on its own model; the rest follow the org's.
	discoveryModel: profile === "quick" ? "openai/gpt-6-luna" : null,
	validationModel: null,
	createdBy: "user_maya",
	createdAt: now - 20 * DAY,
	updatedAt: now - 20 * DAY,
})

export const targetsOf = (now: number) =>
	Schema.decodeSync(SecurityAuditTargetsResponse)({
		targets: [
			target(TARGET_IDS.gateway, "acme/api-gateway", "main", "deep", [], now),
			target(TARGET_IDS.dashboard, "acme/web-dashboard", "main", "deep", [], now),
			target(
				TARGET_IDS.billing,
				"acme/billing-service",
				"release/2026-10",
				"quick",
				["services/billing/src"],
				now,
			),
			target(TARGET_IDS.terraform, "acme/infra-terraform", "main", "deep", ["modules"], now),
		],
	})

type RunSeed = Readonly<{
	id: string
	targetId: string
	status: "in_progress" | "complete" | "incomplete" | "failed"
	profile: "deep" | "quick"
	scopePaths?: ReadonlyArray<string>
	sourceRef: string
	spent: number
	input: number
	output: number
	cost: number | null
	startedAt: number
	finishedAt: number | null
	incompleteReason?: string
	error?: string
}>

const run = (seed: RunSeed) => ({
	id: seed.id,
	targetId: seed.targetId,
	kind: "manual",
	status: seed.status,
	sourceRef: seed.sourceRef,
	profile: seed.profile,
	scopePaths: seed.scopePaths ?? [],
	budget: null,
	invocationsSpent: seed.spent,
	inputTokens: seed.input,
	outputTokens: seed.output,
	costUsd: seed.cost,
	// The default $0.02 sandbox fee per agent invocation.
	sandboxUsd: Math.round(seed.spent * 2) / 100,
	discoveryModel:
		seed.profile === "quick" ? "openai/gpt-6-luna" : "deepseek/deepseek-v4.1-flash-1017:nitro",
	validationModel: "anthropic/claude-sonnet-5.5",
	incompleteReason: seed.incompleteReason ?? null,
	error: seed.error ?? null,
	startedAt: seed.startedAt,
	finishedAt: seed.finishedAt,
})

const runSeeds = (now: number): ReadonlyArray<RunSeed> => [
	{
		id: RUN_IDS.dashboard,
		targetId: TARGET_IDS.dashboard,
		status: "in_progress",
		profile: "deep",
		sourceRef: "4e9a1c7f0d2b8e6a1c3f5d7b9e0a2c4f6b8d0e1a",
		spent: 186,
		input: 9_020_000,
		output: 391_000,
		cost: 97.15,
		startedAt: now - 72 * MINUTE,
		finishedAt: null,
	},
	{
		id: RUN_IDS.gateway,
		targetId: TARGET_IDS.gateway,
		status: "complete",
		profile: "deep",
		sourceRef: "9f3c2a1b7e0d4c6a8b2e1f3d5c7a9b0e2d4f6a8c",
		spent: 352,
		input: 9_420_000,
		output: 380_000,
		cost: 412.8,
		startedAt: now - 2 * HOUR - 221 * MINUTE,
		finishedAt: now - 2 * HOUR,
	},
	{
		id: RUN_IDS.billing,
		targetId: TARGET_IDS.billing,
		status: "incomplete",
		profile: "quick",
		scopePaths: ["services/billing/src"],
		sourceRef: "b71d3e0a5c2f4e6b8d0a1c3e5f7b9d1a3c5e7f9b",
		spent: 120,
		input: 5_610_000,
		output: 224_000,
		cost: 61.02,
		startedAt: now - DAY - 126 * MINUTE,
		finishedAt: now - DAY,
		incompleteReason: "org_spend_limit_reached",
	},
	{
		id: RUN_IDS.billingCancelled,
		targetId: TARGET_IDS.billing,
		status: "incomplete",
		profile: "quick",
		scopePaths: ["services/billing/src"],
		sourceRef: "51be0c9f4a2c6e8b0d1f3a5c7e9b1d3f5a7c9e0b",
		spent: 31,
		input: 1_200_000,
		output: 52_000,
		cost: 14.6,
		startedAt: now - 3 * DAY,
		finishedAt: now - 3 * DAY + 40 * MINUTE,
		incompleteReason: "cancelled",
	},
	{
		id: RUN_IDS.terraform,
		targetId: TARGET_IDS.terraform,
		status: "failed",
		profile: "deep",
		scopePaths: ["modules"],
		sourceRef: "main",
		spent: 0,
		input: 0,
		output: 0,
		cost: 0,
		startedAt: now - 4 * DAY,
		finishedAt: now - 4 * DAY + MINUTE,
		error: "The audit could not start: the sandbox did not come up in time.",
	},
]

/** The org's settings: $1,184 of its $2,000 this month, on the default models. */
export const settingsOf = (now: number) => {
	const date = new Date(now)
	return Schema.decodeSync(SecurityAuditSettings)({
		monthlySpendLimitUsd: 2_000,
		spentUsd: 1_184.32,
		since: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
		resetsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
		discoveryModel: "deepseek/deepseek-v4.1-flash-1017:nitro",
		validationModel: "anthropic/claude-sonnet-5.5",
	})
}

export const runsOf = (now: number) =>
	Schema.decodeUnknownSync(SecurityAuditRunsResponse)({ runs: runSeeds(now).map(run) })

const UNIT_COUNTS = new Map<string, Readonly<Record<string, number>>>([
	[
		RUN_IDS.dashboard,
		{
			covered: 52,
			candidate: 9,
			in_progress: 14,
			planned: 61,
			blocked: 3,
			deferred: 6,
			not_applicable: 3,
		},
	],
	[RUN_IDS.gateway, { covered: 196, candidate: 12, not_applicable: 4 }],
	[RUN_IDS.billing, { covered: 33, candidate: 5, deferred: 12, blocked: 3, planned: 1 }],
	[RUN_IDS.billingCancelled, { covered: 10, planned: 30 }],
	[RUN_IDS.terraform, {}],
])

const REPORTS = {
	report: "# Security audit report\n\nacme/billing-service at b71d3e0, quick profile, scope services/billing/src.\n\n## Summary\n\n3 confirmed findings, 1 needs validation, 1 rejected.\n\n## Coverage\n\n38 of 54 units closed. 16 units are gaps: 12 deferred when the org reached its monthly spend limit, 3 blocked on missing context, 1 planned and never assigned.\n",
	findingsDetail:
		"# Findings detail\n\n## Webhook replay accepted after signature window\n\nThe handler verifies the signature but never checks the timestamp against a window.\n",
	needsValidation:
		"# Needs validation\n\n## Proration job may run twice under retry\n\nNeeds a retry under load to observe.\n",
}

export const runDetailOf = (now: number, runId: string) => {
	const seed = runSeeds(now).find((candidate) => candidate.id === runId)
	if (seed === undefined) throw new RangeError(`No fixture run ${runId}`)
	const counts = UNIT_COUNTS.get(seed.id) ?? {}
	return Schema.decodeUnknownSync(SecurityAuditRunDetail)({
		...run(seed),
		reports: seed.finishedAt === null || seed.status === "failed" ? null : REPORTS,
		architectureMd: null,
		executionProfile:
			seed.status === "failed"
				? null
				: {
						mode: "source_only",
						ecosystems: ["node", "go"],
						privateDependencies: [".npmrc: private source npm.pkg.github.com"],
						reasons: [
							"no execution sandbox for Node.js, Go yet",
							"private dependencies detected, which cannot be installed without credentials (.npmrc: private source npm.pkg.github.com)",
						],
					},
		unitCounts: counts,
		unitTotal: Object.values(counts).reduce((sum, count) => sum + count, 0),
	})
}

type EventSeed = Readonly<{
	ago: number
	kind: "Agent" | "Phase" | "Note"
	message?: string
	phase?: string
	detail?: string
	role?: string
	agentId?: string
	outcome?: string
	cost?: number
}>

const EVENTS: ReadonlyArray<EventSeed> = [
	{
		ago: 0.2,
		kind: "Agent",
		role: "hunter",
		agentId: "h-2-07",
		outcome: "ok",
		message: "Share tokens are 128-bit and compared in constant time.",
		cost: 0.84,
	},
	{
		ago: 0.7,
		kind: "Agent",
		role: "hunter",
		agentId: "h-2-05",
		outcome: "ok",
		message: "Avatar path is built from the upload filename without basename().",
		cost: 1.12,
	},
	{
		ago: 3.3,
		kind: "Phase",
		phase: "wave-2",
		detail: "23 hunters over 23 units",
		message: "Wave 2 started with 23 units assigned.",
	},
	{
		ago: 3.4,
		kind: "Agent",
		role: "critic",
		agentId: "c-1",
		outcome: "ok",
		message: "Added 11 units, including graphql resolvers and admin impersonation.",
		cost: 0.61,
	},
	{
		ago: 12,
		kind: "Agent",
		role: "hunter",
		agentId: "h-1-18",
		outcome: "ok",
		message: "SameSite policy is set by deploy config that is not in the repository.",
		cost: 0.47,
	},
	{
		ago: 38,
		kind: "Phase",
		phase: "wave-1",
		detail: "137 hunters over 137 units",
		message: "Wave 1 started with 137 units.",
	},
	{
		ago: 51,
		kind: "Note",
		message: "Code execution is unavailable. Candidates that need it stay needs validation.",
	},
	{
		ago: 53,
		kind: "Phase",
		phase: "ledger-seeded",
		detail: "137 units mapped · 6 agents",
		message: "Recon complete. architecture.md written, 137 units in the ledger.",
	},
	{
		ago: 60,
		kind: "Phase",
		phase: "reconnaissance",
		detail: "No prior ledger exists.",
		message: "Reconnaissance started.",
	},
]

const phase = (ago: number, name: string, detail: string, message: string): EventSeed => ({
	ago,
	kind: "Phase",
	phase: name,
	detail,
	message,
})

const RECON: ReadonlyArray<EventSeed> = [
	phase(
		53,
		"ledger-seeded",
		"137 units mapped · 6 agents",
		"Recon complete. architecture.md written, 137 units in the ledger.",
	),
	phase(60, "reconnaissance", "No prior ledger exists.", "Reconnaissance started."),
]

/** Each run's own log, newest first: what its engine would have written. */
const EVENTS_BY_RUN = new Map<string, ReadonlyArray<EventSeed>>([
	[RUN_IDS.dashboard, EVENTS],
	[
		RUN_IDS.gateway,
		[
			phase(1, "finished", "complete, 352 agents run", "Run finished complete."),
			phase(9, "record-verification", "12 records", "Fresh verifiers re-checked 12 records."),
			phase(30, "candidate-validation", "14 unique candidates", "Validation of 14 candidates."),
			phase(44, "wave-1", "196 hunters over 196 units", "Wave 1 started with 196 units."),
			...RECON,
		],
	],
	[
		RUN_IDS.billing,
		[
			phase(-1, "finished", "incomplete, 120 agents run", "Run finished incomplete."),
			phase(-0.5, "candidate-validation", "5 candidates checked", "Validation of 5 candidates."),
			...EVENTS,
		],
	],
	[
		RUN_IDS.billingCancelled,
		[
			{ ago: 2, kind: "Note", message: "Cancelled by an admin. The units in flight were released." },
			phase(38, "wave-1", "10 hunters over 10 units", "Wave 1 started with 10 units."),
			...RECON,
		],
	],
	[RUN_IDS.terraform, []],
])

export const eventsOf = (now: number, runId: string) =>
	Schema.decodeSync(SecurityAuditEventsResponse)({
		events: (EVENTS_BY_RUN.get(runId) ?? []).map((event, index) => ({
			id: `${runId}_evt_${index}`,
			at: now - event.ago * MINUTE,
			kind: event.kind,
			role: event.role ?? null,
			agentId: event.agentId ?? null,
			outcome: event.outcome ?? null,
			message: event.message ?? null,
			phase: event.phase ?? null,
			detail: event.detail ?? null,
			costUsd: event.cost ?? null,
			inputTokens: null,
			outputTokens: null,
		})),
	})

const unit = (
	coverageId: string,
	status: string,
	wave: number,
	subsystem: string | null,
	attackClass: string | null,
	surface: string | null,
	boundary: string | null,
	extra: Readonly<{
		agentId?: string
		results?: ReadonlyArray<string>
		unresolved?: ReadonlyArray<string>
		stale?: boolean
	}> = {},
) => ({
	coverageId,
	status,
	wave,
	agentId: extra.agentId ?? null,
	stale: extra.stale ?? false,
	subsystem,
	surface,
	boundary,
	attackClass,
	priorStatus: null,
	priority: null,
	failedAttempts: null,
	resultFingerprints: extra.results ?? [],
	carriedFingerprint: null,
	unresolved: extra.unresolved ?? [],
})

export const unitsOf = () =>
	Schema.decodeUnknownSync(SecurityAuditUnitsResponse)({
		units: [
			unit(
				"u-exports-bola",
				"covered",
				1,
				"exports",
				"broken object authorization",
				"POST /v1/exports",
				"tenant boundary",
			),
			unit(
				"u-auth-redirect",
				"candidate",
				1,
				"auth callback",
				"open redirect",
				"GET /auth/callback",
				"user session",
				{ results: ["fp-open-redirect"] },
			),
			unit(
				"u-webhooks-sig",
				"covered",
				1,
				"webhooks",
				"signature bypass",
				"POST /webhooks/stripe",
				"external caller",
			),
			unit(
				"u-share-token",
				"in_progress",
				2,
				"share links",
				"token guessing",
				"GET /share/:token",
				"anonymous",
				{ agentId: "hunter h-2-07" },
			),
			unit(
				"u-avatar-path",
				"in_progress",
				2,
				"avatar upload",
				"path traversal",
				"POST /api/avatars",
				"file storage",
				{ agentId: "hunter h-2-05" },
			),
			unit(
				"u-graphql-authz",
				"planned",
				2,
				"graphql resolvers",
				"authorization bypass",
				"/graphql",
				"tenant boundary",
			),
			unit(
				"u-session-fixation",
				"blocked",
				1,
				"session cookies",
				"fixation",
				"middleware/session.ts",
				"browser",
				{ unresolved: ["needs deploy config"] },
			),
			unit(
				"u-refunds-race",
				"deferred",
				0,
				"refunds",
				"race condition on double submit",
				"POST /refunds",
				"payment provider",
				{ unresolved: ["Not reached before the spend limit"] },
			),
			unit(
				"u-invoice-pdf",
				"deferred",
				0,
				"invoice pdf",
				"path traversal",
				"GET /invoices/:id/pdf",
				"file storage",
				{ unresolved: ["Not reached before the spend limit"] },
			),
			unit("u-legacy-7f2a91", "planned", 0, null, null, null, null, { stale: true }),
			unit(
				"u-markdown-xss",
				"not_applicable",
				1,
				"markdown render",
				"stored XSS",
				"app/notes/render.tsx",
				"other users",
			),
		],
	})

type FindingSeed = Readonly<{
	fingerprint: string
	targetId: string
	verdict: "confirmed" | "needs_validation" | "rejected"
	severity: "critical" | "high" | "medium" | "low" | null
	status?: "open" | "fixed" | "dismissed" | "accepted_risk"
	title: string
	file: string
	line: number
	runId: string
	ago: number
	createdAgo?: number
}>

const record = (seed: FindingSeed) => {
	const common = {
		fingerprint: seed.fingerprint,
		title: seed.title,
		description:
			"POST /v1/exports reads tenantId from the JSON body and passes it to the export query. The session's tenant is never compared with it, so any signed-in user can export another tenant's data by changing one field.",
		trace: [
			{
				kind: "entrypoint",
				file: seed.file,
				line: seed.line,
				scope: "createExport",
				description:
					"Any authenticated session reaches the handler. The body is parsed without a tenant check.",
			},
			{
				kind: "sink",
				file: "src/exports/query.ts",
				line: 31,
				scope: "selectRows",
				description:
					"The id goes straight into the WHERE clause. No other filter limits the rows to the caller.",
			},
		],
		evidence: [{ file: seed.file, line: seed.line, description: "tenantId is read from the body." }],
	}
	if (seed.verdict === "confirmed")
		return {
			...common,
			verdict: "confirmed",
			root_cause:
				"The handler trusts a client-supplied tenant id instead of the one bound to the session.",
			intended_behavior:
				"Exports are scoped to the caller's tenant. Every other route reads it from ctx.session.tenantId.",
			conditions: [
				{ kind: "authentication_level", description: "any signed-in user" },
				{ kind: "data_state", description: "target tenant id known" },
			],
			execution: {
				attacker_perspective:
					"A user with any account in a different tenant, using only the public API and their own session cookie.",
				payloads: ['POST /v1/exports\n{ "tenantId": "tn_8f21c0", "range": "last_90_days" }'],
				instructions: [
					"Sign in to your own tenant and copy the session cookie.",
					"Send the request above with another tenant's id. Ids appear in shared dashboard links.",
					"Download the finished export from GET /v1/exports/:jobId.",
				],
				observed_result:
					"Shown from source only: the query returns the other tenant's rows. Not executed, since audits cannot run code yet.",
			},
			remediation: {
				strategy:
					"Drop tenantId from the request schema and take it from the session, as the other export routes do.",
				code_changes: [
					{
						file_name: seed.file,
						fixed_code:
							"const job = await exports.start({ tenantId: ctx.session.tenantId, range: body.range })",
					},
				],
			},
			severity: {
				likelihood: {
					score: "high",
					reason: "Needs only a normal account and a tenant id, which appears in shared links.",
				},
				impact: {
					score: seed.severity ?? "low",
					reason: "Full read of another tenant's event history, including user emails.",
				},
				overall_severity: seed.severity ?? "low",
			},
			confidence: { score: "high", reason: "Every cited line was re-read and the trace reproduced." },
		}
	if (seed.verdict === "needs_validation")
		return {
			...common,
			verdict: "needs_validation",
			claimed_root_cause: "The job is not idempotent and the queue retries on timeout.",
			blockers: ["needs a retry under load to observe"],
			validation_plan: { local: "Run the job twice against one invoice and compare the ledger rows." },
		}
	return {
		...common,
		verdict: "rejected",
		claimed_root_cause: "The admin export route skips the role check.",
		reason: "The route is mounted behind requireAdmin in the router; the hunter read the handler alone.",
	}
}

const FINDINGS: ReadonlyArray<FindingSeed> = [
	{
		fingerprint: "exports-tenant-body-8b9e",
		targetId: TARGET_IDS.gateway,
		verdict: "confirmed",
		severity: "critical",
		title: "Tenant id taken from request body in /v1/exports",
		file: "src/routes/exports.ts",
		line: 88,
		runId: RUN_IDS.gateway,
		ago: 2 * HOUR,
	},
	{
		fingerprint: "webhook-timing-1d4c",
		targetId: TARGET_IDS.gateway,
		verdict: "confirmed",
		severity: "high",
		title: "Webhook signature compared with non-constant-time equality",
		file: "src/webhooks/verify.ts",
		line: 41,
		runId: RUN_IDS.gateway,
		ago: 2 * HOUR,
	},
	{
		fingerprint: "open-redirect-2b7f",
		targetId: TARGET_IDS.dashboard,
		verdict: "confirmed",
		severity: "high",
		title: "Open redirect through returnTo on sign-in callback",
		file: "app/auth/callback.ts",
		line: 23,
		runId: RUN_IDS.dashboard,
		ago: 18 * MINUTE,
		createdAgo: 18 * MINUTE,
	},
	{
		fingerprint: "webhook-replay-77aa",
		targetId: TARGET_IDS.billing,
		verdict: "confirmed",
		severity: "high",
		title: "Webhook replay accepted after signature window",
		file: "src/webhooks/handler.ts",
		line: 57,
		runId: RUN_IDS.billing,
		ago: DAY,
	},
	{
		fingerprint: "currency-precision-91c0",
		targetId: TARGET_IDS.billing,
		verdict: "confirmed",
		severity: "medium",
		title: "Invoice totals trust client-sent currency precision",
		file: "src/invoices/create.ts",
		line: 131,
		runId: RUN_IDS.billing,
		ago: DAY,
	},
	{
		fingerprint: "session-token-log-04de",
		targetId: TARGET_IDS.gateway,
		verdict: "confirmed",
		severity: "medium",
		title: "Session token logged at debug level on refresh",
		file: "src/auth/refresh.ts",
		line: 72,
		runId: RUN_IDS.gateway,
		ago: 2 * HOUR,
	},
	{
		fingerprint: "stripe-email-meta-5e21",
		targetId: TARGET_IDS.billing,
		verdict: "confirmed",
		severity: "low",
		title: "Customer email echoed into Stripe metadata unescaped",
		file: "src/stripe/customer.ts",
		line: 44,
		runId: RUN_IDS.billing,
		ago: DAY,
	},
	{
		fingerprint: "ratelimit-xff-3a19",
		targetId: TARGET_IDS.gateway,
		verdict: "confirmed",
		severity: "high",
		status: "dismissed",
		title: "Rate limit keyed on X-Forwarded-For set by the client",
		file: "src/middleware/limit.ts",
		line: 19,
		runId: RUN_IDS.gateway,
		ago: 2 * HOUR,
	},
	{
		fingerprint: "cors-wildcard-6b02",
		targetId: TARGET_IDS.gateway,
		verdict: "confirmed",
		severity: "low",
		status: "fixed",
		title: "CORS allows any origin with credentials on /v1/health",
		file: "src/app.ts",
		line: 12,
		runId: RUN_IDS.gateway,
		ago: 3 * DAY,
	},
	{
		fingerprint: "proration-twice-c4b1",
		targetId: TARGET_IDS.billing,
		verdict: "needs_validation",
		severity: null,
		title: "Proration job may run twice under retry",
		file: "src/jobs/proration.ts",
		line: 22,
		runId: RUN_IDS.billing,
		ago: DAY,
	},
	{
		fingerprint: "ssrf-image-proxy-0e88",
		targetId: TARGET_IDS.gateway,
		verdict: "needs_validation",
		severity: null,
		title: "SSRF through image proxy redirect following",
		file: "src/proxy/image.ts",
		line: 64,
		runId: RUN_IDS.gateway,
		ago: 2 * HOUR,
	},
	{
		fingerprint: "admin-export-role-ff10",
		targetId: TARGET_IDS.billing,
		verdict: "rejected",
		severity: null,
		title: "Admin export reachable without role check",
		file: "src/admin/export.ts",
		line: 15,
		runId: RUN_IDS.billing,
		ago: DAY,
	},
]

const findingOf = (seed: FindingSeed, now: number) => ({
	fingerprint: seed.fingerprint,
	targetId: seed.targetId,
	verdict: seed.verdict,
	overallSeverity: seed.severity,
	status: seed.status ?? "open",
	statusReason:
		seed.status === "dismissed"
			? "The edge proxy overwrites X-Forwarded-For before the request reaches us."
			: null,
	statusChangedBy: seed.status === "dismissed" ? "user_maya" : null,
	statusChangedAt: seed.status === "dismissed" ? now - HOUR : null,
	record: record(seed),
	firstSeenRunId: seed.runId,
	lastSeenRunId: seed.runId,
	firstSeenRef: "9f3c2a1",
	lastSeenRef: "9f3c2a1b7e0d4c6a8b2e1f3d5c7a9b0e2d4f6a8c",
	fixedRunId: seed.status === "fixed" ? RUN_IDS.gateway : null,
	createdAt: now - (seed.createdAgo ?? 5 * DAY),
	updatedAt: now - seed.ago,
})

export const findingsOf = (now: number, targetId: string) =>
	Schema.decodeUnknownSync(SecurityAuditFindingsResponse)({
		findings: FINDINGS.filter((seed) => seed.targetId === targetId).map((seed) => findingOf(seed, now)),
	})

export const githubStatusOf = (connected = true) =>
	Schema.decodeUnknownSync(GithubIntegrationStatus)({
		connected,
		state: connected ? "connected" : "not_connected",
		accountLogin: connected ? "acme" : null,
		accountType: connected ? "organization" : null,
		repositorySelection: connected ? "selected" : null,
		ciTracesEnabled: true,
		repositories: connected
			? ["payments-api", "api-gateway", "web-dashboard", "billing-service"].map((name, index) => ({
					id: `00000c01-0000-4000-8000-00000000000${index + 1}`,
					fullName: `acme/${name}`,
					htmlUrl: `https://github.com/acme/${name}`,
					isPrivate: true,
					status: "active",
					syncStatus: "ready",
					lastSyncedAt: null,
					lastSyncError: null,
					trackedBranch: "main",
					branches: [{ name: "main", isDefault: true }],
					prReviewEnabled: false,
				}))
			: [],
	})
