/**
 * The Postgres side of the provider world: the integrations `list_integrations` reports, named to
 * match `provider-world.ts` (same zones, Railway project and databases). Times are relative to now
 * so poller freshness reads the same on every run. Facts an agent should find:
 *
 * - GitHub: `acme/api` stopped syncing (the App lost access); `acme/shop` is fine, PR review on.
 * - Cloudflare: zone analytics for `status.example.com` fail on a missing token permission.
 * - Railway: `shop / preview` last synced 4 hours ago (stale, so it reports no metrics in the warehouse
 *   world); `shop / production` and `shop / staging` are fresh.
 * - PlanetScale: metrics flow (managed scrape healthy); deploy-request sync for `maple-analytics` fails.
 * - Prometheus: `legacy-exporter` scrapes fail with connection refused; `node-exporter` is fine.
 * - No chat workspace is linked.
 */
import { executeSql } from "@maple/backend/platform/test-pglite"
import { parseWarehouseDateTime } from "@maple/query-engine"
import type { EvalRuntime } from "./eval-runtime"
import type { FixtureRule } from "./fake-warehouse"
import { FIXTURES } from "./utils"

export const INTEGRATION_WORLD = {
	brokenRepo: "acme/api",
	failingZone: "status.example.com",
	staleRailwayEnvironment: "shop / preview",
	failingPlanetScaleDatabase: "maple-analytics",
	failingScrapeTarget: "legacy-exporter",
} as const

const MINUTE = 60_000

export const seedIntegrationWorld = async (rt: EvalRuntime) => {
	const now = Date.now()
	const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE).toISOString()
	const org = FIXTURES.orgId
	const created = at(60 * 24 * 40)
	const sql = (text: string, params: unknown[]) => executeSql(rt.testDb, text, params)

	// The org has received telemetry, so audit_setup runs its checks instead of stopping at onboarding.
	await sql(
		`INSERT INTO org_onboarding_state (org_id, first_data_received_at, created_at, updated_at)
		 VALUES ($1, $2, $2, $2)`,
		[org, created],
	)

	// Every integration row sends as its source, as the connect flows create it.
	const source = (id: string, platform: string, name: string) =>
		sql(
			`INSERT INTO sources (id, org_id, name, platform, kind, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 'integration', $5, $5)`,
			[id, org, name, platform, created],
		)
	await source("5e0a1c3b-0000-4000-8000-0000000000c1", "cloudflare", "Acme")
	await source("5e0a1c3b-0000-4000-8000-0000000000c2", "github", "GitHub acme")
	await source("5e0a1c3b-0000-4000-8000-0000000000c3", "railway", "acme")
	await source("5e0a1c3b-0000-4000-8000-0000000000c4", "planetscale", "PlanetScale acme")
	await source("5e0a1c3b-0000-4000-8000-0000000000c5", "prometheus", "node-exporter")
	await source("5e0a1c3b-0000-4000-8000-0000000000c6", "prometheus", INTEGRATION_WORLD.failingScrapeTarget)

	const oauth = (id: string, provider: string, account: string, sourceId: string | null) =>
		sql(
			`INSERT INTO oauth_connections (id, org_id, provider, external_user_id, external_account_name,
				connected_by_user_id, access_token_ciphertext, access_token_iv, access_token_tag, source_id,
				created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 'user_eval', 'c', 'i', 't', $6, $7, $7)`,
			[id, org, provider, `${provider}-user`, account, sourceId, created],
		)
	await oauth("oauth_cf", "cloudflare", "Acme", "5e0a1c3b-0000-4000-8000-0000000000c1")
	await oauth("oauth_ps", "planetscale", "acme", null)

	await sql(
		`INSERT INTO vcs_installations (id, org_id, provider, external_installation_id, account_login, account_type,
			external_account_id, installed_by_user_id, source_id, created_at, updated_at)
		 VALUES ('7a1e0c3b-2f4d-4c8e-9b61-5d2a7e4f1c01', $1, 'github', '4242', 'acme', 'organization', '99', 'user_eval',
			'5e0a1c3b-0000-4000-8000-0000000000c2', $2, $2)`,
		[org, created],
	)
	const repo = (
		id: string,
		name: string,
		sync: string,
		synced: string | null,
		error: string | null,
		review: boolean,
	) =>
		sql(
			`INSERT INTO vcs_repositories (id, org_id, provider, installation_id, external_repo_id, owner, name, full_name,
				tracked_branch, html_url, sync_status, last_synced_at, last_sync_error, pr_review_enabled, created_at, updated_at)
			 VALUES ($1, $2, 'github', '7a1e0c3b-2f4d-4c8e-9b61-5d2a7e4f1c01', $1, 'acme', $3, $4, 'main', $5, $6, $7, $8, $9, $10, $10)`,
			[
				id,
				org,
				name,
				`acme/${name}`,
				`https://github.com/acme/${name}`,
				sync,
				synced,
				error,
				review,
				created,
			],
		)
	await repo("7a1e0c3b-2f4d-4c8e-9b61-5d2a7e4f1c11", "shop", "ready", at(3), null, true)
	await repo(
		"7a1e0c3b-2f4d-4c8e-9b61-5d2a7e4f1c12",
		"api",
		"error",
		at(60 * 26),
		"Not Found: the GitHub App installation no longer has access to this repository",
		false,
	)

	const cfState = (
		id: string,
		dataset: string,
		zoneId: string,
		zoneName: string | null,
		ok: number,
		err?: string,
	) =>
		sql(
			`INSERT INTO cloudflare_analytics_state (id, org_id, account_id, dataset, zone_id, zone_name,
				last_success_at, last_error_at, last_error, created_at, updated_at)
			 VALUES ($1, $2, 'acct_1', $3, $4, $5, $6, $7, $8, $9, $9)`,
			[id, org, dataset, zoneId, zoneName, at(ok), err ? at(2) : null, err ?? null, created],
		)
	await cfState("cf_shop", "http_requests", "z1", "shop.example.com", 3)
	await cfState("cf_api", "http_requests", "z2", "api.example.com", 3)
	await cfState(
		"cf_status",
		"http_requests",
		"z3",
		INTEGRATION_WORLD.failingZone,
		60 * 9,
		"authentication error (10000): the token lacks Analytics:Read on this zone",
	)
	await cfState("cf_workers", "workers_invocations", "", null, 4)
	await sql(
		`INSERT INTO cloudflare_hyperdrive_configs (id, org_id, config_id, name, origin_host, origin_port,
			origin_scheme, origin_database, created_at, updated_at)
		 VALUES ('hd_1', $1, 'a1b2c3', 'maple-prod', 'aws.connect.psdb.cloud', 5432, 'postgres', 'maple-prod', $2, $2)`,
		[org, created],
	)

	await sql(
		`INSERT INTO railway_connections (id, org_id, token_ciphertext, token_iv, token_tag, workspace_names,
			connected_by_user_id, last_success_at, source_id, created_at, updated_at)
		 VALUES ('rw_1', $1, 'c', 'i', 't', 'acme', 'user_eval', $2, '5e0a1c3b-0000-4000-8000-0000000000c3', $3, $3)`,
		[org, at(2), created],
	)
	const railwayEnv = (id: string, env: string, services: Record<string, string>, ok: number) =>
		sql(
			`INSERT INTO railway_environments (id, org_id, connection_id, project_id, project_name, environment_id,
				environment_name, services_json, last_success_at, created_at, updated_at)
			 VALUES ($1, $2, 'rw_1', 'p_shop', 'shop', $1, $3, $4, $5, $6, $6)`,
			[id, org, env, JSON.stringify(services), at(ok), created],
		)
	await railwayEnv("env_prod", "production", { s1: "api", s2: "worker", s3: "web" }, 2)
	await railwayEnv("env_staging", "staging", { s4: "api" }, 3)
	await railwayEnv("env_preview", "preview", { s6: "api", s7: "web" }, 60 * 4)

	await sql(
		`INSERT INTO planetscale_connections (id, org_id, ps_organization, connected_by_user_id,
			detected_permissions_json, last_inventory_at, source_id, created_at, updated_at)
		 VALUES ('ps_1', $1, 'acme', 'user_eval', $2, $3, '5e0a1c3b-0000-4000-8000-0000000000c4', $4, $4)`,
		[
			org,
			JSON.stringify({ readOrganization: true, readDatabases: true, readMetricsEndpoints: true }),
			at(20),
			created,
		],
	)
	for (const [id, name] of [
		["db_prod", "maple-prod"],
		["db_analytics", "maple-analytics"],
	] as const) {
		await sql(
			`INSERT INTO planetscale_databases (id, org_id, database_id, name, kind, region, state, created_at, updated_at)
			 VALUES ($1, $2, $1, $3, 'postgresql', 'aws-eu-central-1', 'ready', $4, $4)`,
			[id, org, name, created],
		)
	}

	const pollState = (id: string, dataset: string, databaseId: string, ok: number, error: string | null) =>
		sql(
			`INSERT INTO planetscale_poll_state (id, org_id, dataset, database_id, last_success_at, last_error_at,
				last_error, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
			[id, org, dataset, databaseId, at(ok), error === null ? null : at(3), error, created],
		)
	await pollState("pps_inv", "inventory", "", 20, null)
	await pollState("pps_prod", "deploy_requests", "db_prod", 4, null)
	await pollState(
		"pps_analytics",
		"deploy_requests",
		"db_analytics",
		60 * 30,
		"PlanetScale API returned HTTP 404 for deploy-requests: the database's branch was renamed",
	)

	const target = (
		id: string,
		name: string,
		url: string,
		ok: number,
		error: string | null,
		sourceId: string,
		managedBy?: string,
	) =>
		sql(
			`INSERT INTO scrape_targets (id, org_id, name, url, last_scrape_at, last_scrape_error, managed_by,
				source_id, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
			[id, org, name, url, at(ok), error, managedBy ?? null, sourceId, created],
		)
	await target(
		"6f1c2a52-6b0e-4d7e-9a7e-0c1d2e3f4a50",
		"PlanetScale acme",
		"https://api.planetscale.com/v1/organizations/acme/metrics",
		1,
		null,
		"5e0a1c3b-0000-4000-8000-0000000000c4",
		"planetscale:ps_1",
	)
	await target(
		"6f1c2a52-6b0e-4d7e-9a7e-0c1d2e3f4a51",
		"node-exporter",
		"https://metrics.acme.dev/node?token=fixture-secret",
		1,
		null,
		"5e0a1c3b-0000-4000-8000-0000000000c5",
	)
	await target(
		"6f1c2a52-6b0e-4d7e-9a7e-0c1d2e3f4a52",
		INTEGRATION_WORLD.failingScrapeTarget,
		"http://10.0.4.12:9100/metrics",
		60 * 30,
		"dial tcp 10.0.4.12:9100: connect: connection refused",
		"5e0a1c3b-0000-4000-8000-0000000000c6",
	)

	// What each poller last reported for this world, as `reportPoll` writes it.
	await sql(
		`UPDATE sources s SET last_poll_at = t.last_scrape_at,
			last_poll_ok_at = CASE WHEN t.last_scrape_error IS NULL THEN t.last_scrape_at END,
			last_poll_error = t.last_scrape_error
		 FROM scrape_targets t WHERE t.source_id = s.id AND s.platform = 'prometheus'`,
		[],
	)
	const reported = (
		platform: string,
		okMinutesAgo: number,
		error: string | null,
		total: number,
		unhealthy: number,
	) =>
		sql(
			`UPDATE sources SET last_poll_at = $2, last_poll_ok_at = $2, last_poll_error = $3,
				poll_resources = $4::jsonb WHERE platform = $1`,
			[platform, at(okMinutesAgo), error, JSON.stringify({ total, unhealthy })],
		)
	await reported(
		"github",
		3,
		"acme/api: Not Found: the GitHub App installation no longer has access to this repository",
		2,
		1,
	)
	await reported(
		"cloudflare",
		2,
		`${INTEGRATION_WORLD.failingZone}: authentication error (10000): the token lacks Analytics:Read on this zone`,
		4,
		1,
	)
	// `shop / preview` is four hours behind while the poll itself works: stale, not failing.
	await reported("railway", 2, null, 3, 1)
	await reported(
		"planetscale",
		4,
		"maple-analytics: PlanetScale API returned HTTP 404 for deploy-requests: the database's branch was renamed",
		3,
		1,
	)
}

// ---------------------------------------------------------------------------------------------
// CI runs and commits. `checkout` (production) moved from BASE to HEAD; between them on acme/shop
// main: a coupon-stacking change that broke `test (small-6)` in CI, a payment retry fix, a bump.
// CI on main has failed since the coupon commit; the Deploy workflow and acme/api CI pass.

export const CI_WORLD = {
	base: "4f2c9e1a7b3d5e6f8091a2b3c4d5e6f708192a3b",
	couponCommit: "9b7e4d21c0a38f5e6d1b2c3a4f5e6d7c8b9a0f1e",
	retryCommit: "c3d8a1f05e2b7c9d4a6e8f0b1c2d3e4f5a6b7c8d",
	head: "e81b5c3f9a2d4e6c8b0a1f2e3d4c5b6a7f8e9d0c",
	failingJob: "test (small-6)",
	failureReason: "FAIL src/cart.test.ts > applies stacked coupons: expected 90 to be 80",
} as const

const COMMITS = [
	{ sha: CI_WORLD.base, title: "feat(checkout): show delivery estimate", author: "maya", hoursAgo: 50 },
	{
		sha: CI_WORLD.couponCommit,
		title: "feat(cart): allow stacking two coupons",
		author: "jonas",
		hoursAgo: 30,
	},
	{
		sha: CI_WORLD.retryCommit,
		title: "fix(checkout): retry payment timeouts once",
		author: "maya",
		hoursAgo: 20,
	},
	{ sha: CI_WORLD.head, title: "chore: bump effect to 4.0.3", author: "renovate[bot]", hoursAgo: 10 },
] as const

export const seedCommitWorld = async (rt: EvalRuntime) => {
	const now = Date.now()
	for (const [i, commit] of COMMITS.entries()) {
		const committed = new Date(now - commit.hoursAgo * 3_600_000).toISOString()
		await executeSql(
			rt.testDb,
			`INSERT INTO vcs_commits (id, org_id, provider, repository_id, sha, message, author_login, committed_at,
				html_url, created_at)
			 VALUES ($1, $2, 'github', '7a1e0c3b-2f4d-4c8e-9b61-5d2a7e4f1c11', $3, $4, $5, $6, $7, $6)`,
			[
				`7a1e0c3b-2f4d-4c8e-9b61-5d2a7e4f1d0${i}`,
				FIXTURES.orgId,
				commit.sha,
				`${commit.title}\n\nBody text.`,
				commit.author,
				committed,
				`https://github.com/acme/shop/commit/${commit.sha}`,
			],
		)
	}
}

const wire = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

interface CiRunFixture {
	readonly traceId: string
	readonly repository: string
	readonly pipeline: string
	readonly result: string
	readonly revision: string
	readonly hoursAgo: number
	readonly minutes: number
}

const CI_RUNS: ReadonlyArray<CiRunFixture> = [
	{
		traceId: "c1",
		repository: "shop",
		pipeline: "CI",
		result: "failure",
		revision: CI_WORLD.head,
		hoursAgo: 10,
		minutes: 14,
	},
	{
		traceId: "c2",
		repository: "shop",
		pipeline: "Deploy",
		result: "success",
		revision: CI_WORLD.head,
		hoursAgo: 10,
		minutes: 6,
	},
	{
		traceId: "c3",
		repository: "shop",
		pipeline: "CI",
		result: "failure",
		revision: CI_WORLD.retryCommit,
		hoursAgo: 20,
		minutes: 13,
	},
	{
		traceId: "c4",
		repository: "shop",
		pipeline: "CI",
		result: "failure",
		revision: CI_WORLD.couponCommit,
		hoursAgo: 30,
		minutes: 15,
	},
	{
		traceId: "c5",
		repository: "shop",
		pipeline: "CI",
		result: "success",
		revision: CI_WORLD.base,
		hoursAgo: 50,
		minutes: 9,
	},
	{
		traceId: "c6",
		repository: "api",
		pipeline: "CI",
		result: "success",
		revision: "1d4e7a9c2b5f8e0d3a6c9b2e5f8a1d4c7b0e3f6a",
		hoursAgo: 6,
		minutes: 7,
	},
]
	.map((run) => ({ ...run, traceId: run.traceId.padEnd(32, "0") }))
	.sort((a, b) => a.hoursAgo - b.hoursAgo)

const inWindow = (sql: string, hoursAgo: number) => {
	const stamps = [...sql.matchAll(/'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)'/g)].map((m) =>
		parseWarehouseDateTime(m[1] ?? ""),
	)
	const at = Date.now() - hoursAgo * 3_600_000
	return (stamps[0] === undefined || at >= stamps[0]) && (stamps[1] === undefined || at <= stamps[1])
}

export const integrationFixtureRules = (): FixtureRule[] => [
	{
		match: (sql) => sql.includes("FROM ci_runs"),
		rows: (sql) =>
			CI_RUNS.filter((run) => inWindow(sql, run.hoursAgo))
				.filter((run) => !sql.includes("'failure'") || run.result === "failure")
				.filter(
					(run) =>
						!sql.includes("Repository = '") || sql.includes(`Repository = '${run.repository}'`),
				)
				.map((run) => ({
					traceId: run.traceId,
					pipeline: run.pipeline,
					runId: `9${run.hoursAgo}0001`,
					result: run.result,
					url: `https://github.com/acme/${run.repository}/actions/runs/9${run.hoursAgo}0001`,
					repository: run.repository,
					branch: "main",
					revision: run.revision,
					attempt: 1,
					trigger: "push",
					actor: "ada",
					pullRequest: 0,
					durationMs: run.minutes * 60_000,
					startedAt: wire(Date.now() - run.hoursAgo * 3_600_000),
				})),
	},
	{
		match: (sql) => sql.includes("FROM ci_jobs"),
		rows: CI_RUNS.filter((run) => run.result === "failure").map((run) => ({
			traceId: run.traceId,
			job: CI_WORLD.failingJob,
			result: "failure",
			reason: CI_WORLD.failureReason,
			url: `https://github.com/acme/shop/actions/runs/9${run.hoursAgo}0001/job/1`,
			durationMs: 9 * 60_000,
		})),
	},
	{
		// service_deployments / compare_commits: checkout's two versions in production.
		match: (sql) => sql.includes(" AS commitSha") && sql.includes("lastSeen"),
		rows: (sql) =>
			sql.includes("'checkout'") || !sql.includes("ServiceName = '")
				? [
						{ commit: CI_WORLD.head, from: 10, to: 0, spans: 412_000, errors: 3_100 },
						{ commit: CI_WORLD.base, from: 50, to: 10, spans: 1_640_000, errors: 4_900 },
					].map((v) => ({
						serviceName: "checkout",
						environment: "production",
						commitSha: v.commit,
						firstSeen: wire(Date.now() - v.from * 3_600_000),
						lastSeen: wire(Date.now() - v.to * 3_600_000),
						spanCount: v.spans,
						errorCount: v.errors,
						p50LatencyMs: 84,
						p95LatencyMs: 410,
						p99LatencyMs: 900,
						apdexSatisfiedCount: v.spans * 0.9,
						apdexToleratingCount: v.spans * 0.08,
					}))
				: [],
	},
]
