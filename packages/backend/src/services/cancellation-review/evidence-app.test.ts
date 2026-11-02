import type { IntegrationInventory } from "@maple/domain/integration-inventory"
import { OrgId, SourceId, SourcePlatform } from "@maple/domain/primitives"
import { Effect, Layer, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	agentFeedbackOf,
	apiKeysOf,
	CancellationAppEvidenceReader,
	disabledDestinationsOf,
	errorClassOf,
	integrationHealthOf,
	onboardingOf,
	type OnboardingRow,
	priorReviewsOf,
	scrapeEvidenceOf,
	type SourceHealthRow,
} from "./evidence-app"
import { DAY_MS } from "./snapshot"

const AT = Date.UTC(2026, 8, 30, 12)
const MINUTE = 60_000
const CREATED = AT - 100 * DAY_MS

describe("errorClassOf", () => {
	it.each([
		["request timed out after 30s", "timeout"],
		["HTTP 429 Too Many Requests", "rate_limited"],
		["authentication error", "auth"],
		["The token expired; senders get 401", "auth"],
		["channel_not_found", "not_found"],
		["zone does not exist", "not_found"],
		["connect ECONNREFUSED 10.0.0.1:9090", "unreachable"],
		["unexpected end of JSON input", "other"],
	])("reads %j as %s", (message, expected) => {
		expect(errorClassOf(message)).toBe(expected)
	})
})

const sourceId = Schema.decodeUnknownSync(SourceId)
const platform = Schema.decodeUnknownSync(SourcePlatform)

const source = (overrides: Partial<SourceHealthRow> & { readonly platform: string }): SourceHealthRow => ({
	id: sourceId(crypto.randomUUID()),
	expiresAt: null,
	pausedAt: null,
	pausedUntil: null,
	lastUsedAt: null,
	lastRejectedAt: null,
	lastRejection: null,
	lastPollOkAt: null,
	lastPollError: null,
	disconnectedAt: null,
	pollResources: null,
	...overrides,
	platform: platform(overrides.platform),
})

const inventory = (entries: IntegrationInventory["integrations"]): IntegrationInventory => ({
	integrations: entries,
	available: [],
})

describe("integrationHealthOf", () => {
	it("lists integrations and the sources the inventory leaves out, worst first, with error classes only", () => {
		const health = integrationHealthOf(
			inventory([
				{
					provider: "github",
					status: "healthy",
					account: "acme",
					connectedAt: AT - 40 * DAY_MS,
					problem: null,
					feeds: [],
					resources: [
						{
							kind: "repository",
							name: "acme/shop",
							status: "healthy",
							lastSuccessAt: AT - 2 * DAY_MS,
							lastError: null,
							note: null,
						},
					],
				},
				{
					provider: "cloudflare",
					status: "failing",
					account: "Acme",
					connectedAt: AT - 40 * DAY_MS,
					problem: "1 of 1 failing, e.g. zone shop.example: authentication error",
					feeds: [],
					resources: [],
				},
			]),
			[
				// Two SDK tokens: the newer data wins, the refusal makes the platform failing.
				source({ platform: "nodejs", lastUsedAt: AT - 5 * DAY_MS }),
				source({
					platform: "nodejs",
					lastUsedAt: AT - DAY_MS,
					lastRejectedAt: AT - MINUTE,
					lastRejection: "Rate limit exceeded",
				}),
				// Reported by the inventory already.
				source({ platform: "cloudflare", lastPollError: "boom" }),
				source({ platform: "gcp", lastUsedAt: AT - 10 * MINUTE }),
			],
			[
				{
					lastReceivedAt: AT - 3 * DAY_MS,
					lastMetricsReceivedAt: null,
					lastError: null,
					lastMetricsError: "PERMISSION_DENIED: monitoring.timeSeries.list",
					lastResourcesError: null,
				},
			],
			AT,
			AT,
		)
		expect(health).toEqual([
			{
				kind: "cloudflare",
				status: "failing",
				lastSuccessDaysBeforeCancel: null,
				lastErrorDaysBeforeCancel: null,
				errorClass: "auth",
			},
			{
				kind: "nodejs",
				status: "failing",
				lastSuccessDaysBeforeCancel: 1,
				lastErrorDaysBeforeCancel: 0,
				errorClass: "rate_limited",
			},
			{
				kind: "github",
				status: "healthy",
				lastSuccessDaysBeforeCancel: 2,
				lastErrorDaysBeforeCancel: null,
				errorClass: null,
			},
			{
				kind: "gcp",
				status: "healthy",
				lastSuccessDaysBeforeCancel: 0,
				lastErrorDaysBeforeCancel: null,
				errorClass: "auth",
			},
		])
	})

	it("shows at most 15", () => {
		const platforms = ["opentelemetry", "nodejs", "python", "go", "java", "dotnet", "ruby", "php", "rust"]
		const health = integrationHealthOf(
			inventory([]),
			[
				...platforms,
				"browser",
				"kubernetes",
				"docker",
				"host",
				"claude_code",
				"cloudflare_ai_gateway",
				"gcp",
			].map((name) => source({ platform: name, lastRejectedAt: AT - DAY_MS })),
			[],
			AT,
			AT,
		)
		expect(health).toHaveLength(15)
	})

	it("leaves out an SDK token with nothing wrong, which mostly reads pending", () => {
		const health = integrationHealthOf(
			inventory([]),
			[source({ platform: "opentelemetry" }), source({ platform: "claude_code" })],
			[],
			AT,
			AT,
		)
		expect(health.map((entry) => entry.kind)).toEqual(["claude_code"])
	})

	it("does not count a refusal after the cancellation as an error before it", () => {
		const health = integrationHealthOf(
			inventory([]),
			[
				source({ platform: "nodejs", lastUsedAt: AT - DAY_MS, lastRejectedAt: AT + DAY_MS }),
				source({ platform: "claude_code", lastUsedAt: AT - DAY_MS, lastRejectedAt: AT + DAY_MS }),
			],
			[],
			AT,
			AT + 2 * DAY_MS,
		)
		expect(health).toEqual([
			{
				kind: "claude_code",
				status: "stale",
				lastSuccessDaysBeforeCancel: 1,
				lastErrorDaysBeforeCancel: null,
				errorClass: null,
			},
		])
	})
})

const onboardingRow: OnboardingRow = {
	demoDataRequested: false,
	onboardingCompletedAt: null,
	checklistDismissedAt: AT - 20 * DAY_MS,
	firstDataReceivedAt: AT - 25 * DAY_MS,
	welcomeEmailSentAt: AT - 30 * DAY_MS,
	connectNudgeEmailSentAt: null,
	stalledEmailSentAt: AT - 10 * DAY_MS,
	activationEmailSentAt: AT - 24 * DAY_MS,
	createdAt: AT - 30 * DAY_MS,
}

describe("onboardingOf", () => {
	it("says when the org never reached onboarding", () => {
		expect(onboardingOf(null, AT)).toMatchObject({ recorded: false, lifecycleEmailsSent: [] })
	})

	it("reads the flow, first data and the emails in the order they went out", () => {
		expect(onboardingOf(onboardingRow, AT)).toEqual({
			recorded: true,
			completed: false,
			checklistDismissed: true,
			demoDataRequested: false,
			firstDataDaysBeforeCancel: 25,
			signupToFirstDataDays: 5,
			lifecycleEmailsSent: ["welcome", "activation", "stalled"],
		})
	})

	it("reads the onboarding as it stood at the cancellation, an hour's grace included", () => {
		expect(
			onboardingOf(
				{
					...onboardingRow,
					onboardingCompletedAt: AT + 2 * DAY_MS,
					checklistDismissedAt: AT + 30 * MINUTE,
					firstDataReceivedAt: AT + DAY_MS,
					stalledEmailSentAt: AT + 3 * DAY_MS,
				},
				AT,
			),
		).toMatchObject({
			completed: false,
			checklistDismissed: true,
			firstDataDaysBeforeCancel: null,
			signupToFirstDataDays: null,
			lifecycleEmailsSent: ["welcome", "activation"],
		})
	})
})

describe("disabledDestinationsOf", () => {
	it("tells a person switching a destination off from Maple disabling it", () => {
		expect(
			disabledDestinationsOf(
				[
					{
						type: "slack",
						createdAt: CREATED,
						enabled: true,
						disabledAt: null,
						disabledReason: null,
					},
					{
						type: "webhook",
						createdAt: CREATED,
						enabled: false,
						disabledAt: null,
						disabledReason: null,
					},
					{
						type: "email",
						createdAt: CREATED,
						enabled: false,
						disabledAt: AT,
						disabledReason: "Last recipient left the organization",
					},
					{
						type: "slack",
						createdAt: CREATED,
						enabled: false,
						disabledAt: AT,
						disabledReason: "Slack said channel_not_found (404)",
					},
				],
				AT,
			),
		).toEqual([
			{ type: "webhook", reason: "manual" },
			{ type: "email", reason: "recipient_left" },
			{ type: "slack", reason: "not_found" },
		])
	})

	it("leaves out what was disabled or created after the cancellation", () => {
		expect(
			disabledDestinationsOf(
				[
					{
						type: "slack",
						createdAt: CREATED,
						enabled: false,
						disabledAt: AT + DAY_MS,
						disabledReason: "Slack said channel_not_found (404)",
					},
					{
						type: "webhook",
						createdAt: AT + DAY_MS,
						enabled: false,
						disabledAt: null,
						disabledReason: null,
					},
				],
				AT,
			),
		).toEqual([])
	})
})

describe("priorReviewsOf", () => {
	it("drops the reviewed cancellation and reads the model's category from any stored read", () => {
		expect(
			priorReviewsOf(
				[
					{ canceledAt: AT - DAY_MS, createdAt: AT, ruleReason: "cost", modelRead: null },
					{
						canceledAt: AT - 200 * DAY_MS,
						createdAt: AT - 200 * DAY_MS,
						ruleReason: "not_engaged",
						modelRead: { category: "switched_service", verdict: "override" },
					},
					// An older stored read without the field.
					{
						canceledAt: null,
						createdAt: AT - 400 * DAY_MS,
						ruleReason: null,
						modelRead: { verdict: "agree" },
					},
				],
				AT,
			),
		).toEqual([
			{ daysBeforeCancel: 200, ruleReason: "not_engaged", modelCategory: "switched_service" },
			{ daysBeforeCancel: 400, ruleReason: null, modelCategory: null },
		])
	})
})

describe("agentFeedbackOf", () => {
	it("takes out addresses, links and keys, and caps the summary", () => {
		const feedback = agentFeedbackOf(
			{
				createdAt: AT - 3 * DAY_MS,
				kind: "bug",
				impact: "blocking",
				summary: ` search_traces times out on https://acme.test/x?k=1 with key key0123456789abcdefghijklmnopqr, ask dev@example.com ${"slow ".repeat(60)}`,
			},
			AT,
		)
		expect(feedback.daysBeforeCancel).toBe(3)
		expect(
			feedback.summary.startsWith(
				"search_traces times out on [url] with key [token], ask [email] slow",
			),
		).toBe(true)
		expect(feedback.summary).toHaveLength(200)
	})
})

describe("scrapeEvidenceOf", () => {
	it("has no failure share without checks", () => {
		expect(
			scrapeEvidenceOf(
				{ targets: 1, enabledTargets: 0, lastScrapeAt: null },
				{ checks: 0, failed: 0 },
				AT,
			),
		).toEqual({
			targets: 1,
			enabledTargets: 0,
			checksLastDay: 0,
			failedCheckShareLastDay: null,
			lastSuccessDaysBeforeCancel: null,
		})
	})

	it("reads the share of failed checks", () => {
		expect(
			scrapeEvidenceOf(
				{ targets: 2, enabledTargets: 2, lastScrapeAt: AT - 4 * DAY_MS },
				{ checks: 8, failed: 6 },
				AT,
			),
		).toMatchObject({ failedCheckShareLastDay: 0.75, lastSuccessDaysBeforeCancel: 4 })
	})
})

describe("apiKeysOf", () => {
	it("counts every kind and the newest use of any key", () => {
		expect(
			apiKeysOf(
				[
					{ kind: "mcp", active: 2, lastUsedAt: AT - 6 * DAY_MS },
					{ kind: "standard", active: 0, lastUsedAt: AT - 40 * DAY_MS },
				],
				AT,
			),
		).toEqual({ active: { standard: 0, mcp: 2, device: 0 }, lastUsedDaysBeforeCancel: 6 })
	})
})

describe("CancellationAppEvidenceReader", () => {
	const dbs: TestDb[] = []
	afterEach(() => cleanupTestDbs(dbs))

	const ORG = Schema.decodeSync(OrgId)("org_app_evidence")
	const seconds = (ms: number) => ms / 1000

	const incident = (db: TestDb, id: string, firstMs: number, resolvedMs: number | null) =>
		executeSql(
			db,
			`INSERT INTO alert_incidents (id, org_id, rule_id, incident_key, rule_name, signal_type, severity, status,
			   comparator, threshold, first_triggered_at, last_triggered_at, resolved_at, dedupe_key, created_at, updated_at)
			 VALUES ($1, $2, 'rule-1', $1, 'Rule', 'error_rate', 'warning', 'resolved', 'gt', 1,
			   to_timestamp($3), to_timestamp($3), to_timestamp($4), $1, now(), now())`,
			[id, ORG, seconds(firstMs), resolvedMs === null ? null : seconds(resolvedMs)],
		)

	const actor = (db: TestDb, id: string, type: "user" | "agent") =>
		executeSql(db, `INSERT INTO actors (id, org_id, type, created_at) VALUES ($1, $2, $3, now())`, [
			id,
			ORG,
			type,
		])

	const issueEvent = (db: TestDb, id: string, actorId: string, atMs: number) =>
		executeSql(
			db,
			`INSERT INTO error_issue_events (id, org_id, issue_id, actor_id, type, created_at)
			 VALUES ($1, $2, 'issue-1', $3, 'comment', to_timestamp($4))`,
			[id, ORG, actorId, seconds(atMs)],
		)

	const read = (db: TestDb) =>
		Effect.runPromise(
			CancellationAppEvidenceReader.use((reader) =>
				reader.read({
					orgId: ORG,
					atMs: AT,
					autumnCustomer: null,
					stripeCustomerId: null,
					ownOrgId: null,
					members: null,
				}),
			).pipe(Effect.provide(CancellationAppEvidenceReader.layer.pipe(Layer.provide(db.layer)))),
		)

	const apiKey = (
		db: TestDb,
		key: {
			readonly id: string
			readonly kind: "standard" | "mcp" | "device"
			readonly createdAt: number
			readonly revokedAt?: number
			readonly expiresAt?: number
			readonly lastUsedAt?: number
		},
	) =>
		executeSql(
			db,
			`INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, kind, revoked, revoked_at, expires_at,
			   last_used_at, created_at, created_by)
			 VALUES ($1, $2, 'k', $1, 'pre', $3, $4, to_timestamp($5), to_timestamp($6), to_timestamp($7),
			   to_timestamp($8), 'user-1')`,
			[
				key.id,
				ORG,
				key.kind,
				key.revokedAt !== undefined,
				key.revokedAt === undefined ? null : seconds(key.revokedAt),
				key.expiresAt === undefined ? null : seconds(key.expiresAt),
				key.lastUsedAt === undefined ? null : seconds(key.lastUsedAt),
				seconds(key.createdAt),
			],
		)

	it("counts the API keys usable at the cancellation", async () => {
		const db = createTestDb(dbs)
		await apiKey(db, {
			id: "revoked-later",
			kind: "standard",
			createdAt: CREATED,
			revokedAt: AT + 2 * DAY_MS,
		})
		await apiKey(db, {
			id: "revoked-before",
			kind: "standard",
			createdAt: CREATED,
			revokedAt: AT - DAY_MS,
		})
		await apiKey(db, { id: "expired-before", kind: "mcp", createdAt: CREATED, expiresAt: AT - DAY_MS })
		await apiKey(db, { id: "device", kind: "device", createdAt: CREATED, lastUsedAt: AT - 4 * DAY_MS })
		// Created after the cancellation: neither counted nor its use read.
		await apiKey(db, {
			id: "created-later",
			kind: "mcp",
			createdAt: AT + DAY_MS,
			lastUsedAt: AT + DAY_MS,
		})

		expect((await read(db)).apiKeys).toEqual({
			active: { standard: 1, mcp: 0, device: 1 },
			lastUsedDaysBeforeCancel: 4,
		})
	})

	it("reads every part from Postgres", async () => {
		const db = createTestDb(dbs)
		await incident(db, "inc-1", AT - 5 * DAY_MS, AT - 5 * DAY_MS + 10 * MINUTE)
		await incident(db, "inc-2", AT - 4 * DAY_MS, AT - 4 * DAY_MS + 30 * MINUTE)
		await incident(db, "inc-3", AT - 45 * DAY_MS, null)
		await actor(db, "actor-user", "user")
		await actor(db, "actor-agent", "agent")
		await issueEvent(db, "ev-1", "actor-user", AT - 2 * DAY_MS)
		await issueEvent(db, "ev-2", "actor-user", AT - 40 * DAY_MS)
		await issueEvent(db, "ev-3", "actor-agent", AT - 2 * DAY_MS)
		await executeSql(
			db,
			`INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, kind, last_used_at, created_at, created_by)
			 VALUES ('key-1', $1, 'k', 'hash-1', 'pre', 'mcp', to_timestamp($2), to_timestamp($3), 'user-1')`,
			[ORG, seconds(AT - 3 * DAY_MS), seconds(CREATED)],
		)

		const evidence = await read(db)

		expect(evidence).toMatchObject({
			integrations: [],
			onboarding: { recorded: false },
			alerts: {
				incidentsRecent: 2,
				incidentsPrior: 1,
				medianIncidentMinutesRecent: 20,
				failingRules: 0,
			},
			anomalies: { incidentsRecent: 0, detectorEnabled: true, mutedSignals: [] },
			investigations: { recent: 0 },
			errorIssues: { open: 0, userActionsRecent: 1, userActionsPrior: 1 },
			agentFeedback: [],
			priorCancellations: [],
			// The test runs after AT: the day of checks before it is pruned.
			scrapeTargets: { targets: 0, checksLastDay: null, failedCheckShareLastDay: null },
			apiKeys: { active: { standard: 0, mcp: 1, device: 0 }, lastUsedDaysBeforeCancel: 3 },
			digest: { subscribers: 0, optedOut: 0, lastOptOutDaysBeforeCancel: null },
		})
	})
})
