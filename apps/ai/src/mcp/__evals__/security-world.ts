/**
 * The Security Center world for the security tools' tests and usability runs. It builds on the
 * integration world (GitHub `acme/shop` and `acme/api`, `checkout` deployed from `CI_WORLD.head`).
 * Facts an agent should find:
 *
 * - Code audit, `acme/shop@main` (complete run a day ago): a confirmed critical cross-tenant order
 *   export (`orders/export-missing-org-scope`), a confirmed high reset-token timing leak, an
 *   unconfirmed high lead (avatar path traversal), a dismissed coupon replay, a rejected SSRF claim
 *   and a fixed JWT `alg: none` finding. `acme/api@main` stopped at the org's spend limit.
 * - Dependencies, `acme/shop` scanned at the deployed commit: `next` 14.1.0 (CVE-2025-29927,
 *   critical, direct, runs in checkout production), `axios` 1.6.0 (CVE-2024-39338, high,
 *   transitive), `cookie` 0.5.0 (medium), `vitest` (low, dev). `acme/api` has no scan.
 * - Exposure: `legacy-admin` served `/.env` with a 200 and `billing` served `/actuator/env`;
 *   `marketing-site` answers every probe (a catch-all SPA, not an exposure); 185.220.101.4 runs nuclei.
 * - Runtimes: checkout on Node.js 18.19.0 (end of life, a high CVE), api-gateway on Node.js 22.4.0
 *   (a critical CVE, behind 22.12.0), legacy-admin on Python 3.8.18 (end of life), billing on
 *   Python 3.12.7 (fine), cart on Bun posing as Node.js, edge-worker on Workers (untracked).
 */
import { Schema } from "effect"
import { executeSql } from "@maple/backend/platform/test-pglite"
import type { EvalRuntime } from "./eval-runtime"
import { type FixtureRule, readsTraceSpans } from "./fake-warehouse"
import { CI_WORLD } from "./integration-world"
import { FIXTURES } from "./utils"

export const SECURITY_WORLD = {
	shopTarget: "5ec0a0d1-0000-4000-8000-000000000001",
	apiTarget: "5ec0a0d1-0000-4000-8000-000000000002",
	criticalFingerprint: "orders/export-missing-org-scope",
	leadFingerprint: "uploads/avatar-path-traversal",
	criticalCve: "CVE-2025-29927",
	nodeCve: "CVE-2025-23166",
	exposedService: "legacy-admin",
	catchAllService: "marketing-site",
} as const

const SHOP_REPO = "7a1e0c3b-2f4d-4c8e-9b61-5d2a7e4f1c11"
const HOUR = 3_600_000
const wire = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")

const trace = (file: string, line: number, sink: string) => [
	{ kind: "entrypoint", file, line, scope: "handler", description: "Request enters the route handler." },
	{ kind: "sink", file, line: line + 6, scope: "handler", description: sink },
]

const confirmed = (
	fingerprint: string,
	title: string,
	file: string,
	line: number,
	severity: "critical" | "high" | "medium",
	extra: { description: string; rootCause: string; fix: string; payload: string; fixedCode: string },
) => ({
	verdict: "confirmed",
	fingerprint,
	title,
	description: extra.description,
	trace: trace(file, line, extra.rootCause),
	evidence: [{ file, line: line + 6, description: extra.rootCause }],
	root_cause: extra.rootCause,
	intended_behavior: "Only the caller's own organization's data is reachable.",
	conditions: [{ kind: "authentication_level", description: "Any signed-in user of any organization." }],
	execution: {
		attacker_perspective: "a signed-in user of another organization",
		payloads: [extra.payload],
		instructions: ["Sign in to any organization.", `Send: ${extra.payload}`],
		observed_result: "The response holds the other organization's records.",
	},
	remediation: {
		strategy: extra.fix,
		code_changes: [{ file_name: file, fixed_code: extra.fixedCode }],
	},
	severity: {
		likelihood: { score: "high", reason: "Reachable by any signed-in user." },
		impact: { score: severity, reason: "Cross-tenant data." },
		overall_severity: severity,
	},
	confidence: { score: "high", reason: "Reproduced against the source." },
})

const CODE_FINDINGS = [
	{
		fingerprint: SECURITY_WORLD.criticalFingerprint,
		verdict: "confirmed",
		overall: "critical",
		estimated: null,
		status: "open",
		reason: null,
		record: confirmed(
			SECURITY_WORLD.criticalFingerprint,
			"Order export returns every organization's orders",
			"src/routes/orders/export.ts",
			42,
			"critical",
			{
				description:
					"GET /api/orders/export reads orders by date range without scoping them to the caller's organization.",
				rootCause: "The export query filters on createdAt only; orgId is never applied.",
				fix: "Filter the export query on the tenant's orgId, as the list route does.",
				payload: "GET /api/orders/export?from=2020-01-01&to=2030-01-01",
				fixedCode: "where(and(eq(orders.orgId, tenant.orgId), between(orders.createdAt, from, to)))",
			},
		),
	},
	{
		fingerprint: "auth/reset-token-timing",
		verdict: "confirmed",
		overall: "high",
		estimated: null,
		status: "open",
		reason: null,
		record: confirmed(
			"auth/reset-token-timing",
			"Password reset tokens compared in non-constant time",
			"src/auth/reset.ts",
			88,
			"high",
			{
				description:
					"The reset handler compares the submitted token to the stored one with ===, leaking a timing signal.",
				rootCause: "String equality short-circuits on the first differing byte.",
				fix: "Compare with crypto.timingSafeEqual over equal-length buffers.",
				payload: "POST /api/auth/reset {token: <guessed prefix>}",
				fixedCode: "crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(stored))",
			},
		),
	},
	{
		fingerprint: SECURITY_WORLD.leadFingerprint,
		verdict: "needs_validation",
		overall: null,
		estimated: "high",
		status: "open",
		reason: null,
		record: {
			verdict: "needs_validation",
			fingerprint: SECURITY_WORLD.leadFingerprint,
			title: "Avatar upload may write outside the uploads directory",
			description:
				"The upload route joins the client's filename onto the uploads directory without normalizing it.",
			trace: trace("src/routes/account/avatar.ts", 17, "path.join(UPLOADS, file.name) is written to."),
			evidence: [
				{
					file: "src/routes/account/avatar.ts",
					line: 23,
					description: "path.join with the raw filename.",
				},
			],
			claimed_root_cause: "A filename like ../../app/config.json escapes the uploads directory.",
			blockers: [
				"Whether the multipart parser strips directory components could not be read from source.",
			],
			validation_plan: { local: "Upload a file named ../../tmp/x.png and check where it lands." },
		},
	},
	{
		fingerprint: "cart/coupon-replay",
		verdict: "confirmed",
		overall: "medium",
		estimated: null,
		status: "dismissed",
		reason: "Coupons are single-use at the payment provider too; replay is refused there.",
		record: confirmed(
			"cart/coupon-replay",
			"A coupon can be applied twice by racing two requests",
			"src/cart/coupons.ts",
			30,
			"medium",
			{
				description: "Two concurrent apply-coupon requests both pass the used check.",
				rootCause: "Check-then-write without a lock or unique constraint.",
				fix: "Mark the coupon used in the same conditional UPDATE.",
				payload: "Two parallel POST /api/cart/coupon",
				fixedCode:
					"UPDATE coupons SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id",
			},
		),
	},
	{
		fingerprint: "checkout/webhook-ssrf",
		verdict: "rejected",
		overall: null,
		estimated: null,
		status: "open",
		reason: null,
		record: {
			verdict: "rejected",
			fingerprint: "checkout/webhook-ssrf",
			title: "Payment webhook URL fetched without validation",
			description: "Claimed SSRF through the webhook callback URL.",
			trace: trace("src/checkout/webhook.ts", 12, "fetch(callbackUrl)"),
			evidence: [
				{ file: "src/checkout/webhook.ts", line: 18, description: "fetch of a configured URL." },
			],
			claimed_root_cause: "callbackUrl comes from the request.",
			reason: "callbackUrl is read from server config, never from the request.",
		},
	},
	{
		fingerprint: "auth/jwt-none-alg",
		verdict: "confirmed",
		overall: "critical",
		estimated: null,
		status: "fixed",
		reason: null,
		record: confirmed(
			"auth/jwt-none-alg",
			"JWTs signed with alg none were accepted",
			"src/auth/jwt.ts",
			10,
			"critical",
			{
				description: "The verifier accepted unsigned tokens.",
				rootCause: "algorithms was not pinned.",
				fix: "Pin algorithms to RS256.",
				payload: "Authorization: Bearer <alg none token>",
				fixedCode: 'jwt.verify(token, key, { algorithms: ["RS256"] })',
			},
		),
	},
] as const

export const seedSecurityWorld = async (rt: EvalRuntime) => {
	const now = Date.now()
	const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString()
	const org = FIXTURES.orgId
	const sql = (text: string, params: unknown[]) => executeSql(rt.testDb, text, params)

	const target = (id: string, repository: string, vcsId: string | null) =>
		sql(
			`INSERT INTO security_audit_targets (id, org_id, repository, vcs_repository_id, branch, enabled, profile,
				scope_paths, created_by, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 'main', true, 'deep', '[]', 'user_eval', $5, $5)`,
			[id, org, repository, vcsId, at(24 * 20)],
		)
	await target(SECURITY_WORLD.shopTarget, "acme/shop", SHOP_REPO)
	await target(SECURITY_WORLD.apiTarget, "acme/api", "7a1e0c3b-2f4d-4c8e-9b61-5d2a7e4f1c12")

	const run = (
		id: string,
		targetId: string,
		status: string,
		startedHoursAgo: number,
		incompleteReason: string | null,
	) =>
		sql(
			`INSERT INTO security_audit_runs (id, org_id, target_id, kind, source_ref, profile, scope_paths, budget, status,
				incomplete_reason, invocations_spent, input_tokens, output_tokens, cost_usd, sandbox_usd, started_at, finished_at)
			 VALUES ($1, $2, $3, 'manual', $4, 'deep', '[]', null, $5, $6, 40, 1000000, 50000, 12.5, 0, $7, $8)`,
			[
				id,
				org,
				targetId,
				CI_WORLD.head,
				status,
				incompleteReason,
				at(startedHoursAgo),
				at(startedHoursAgo - 2),
			],
		)
	await run("run-shop-1", SECURITY_WORLD.shopTarget, "complete", 26, null)
	await run("run-api-1", SECURITY_WORLD.apiTarget, "incomplete", 50, "org_spend_limit_reached")

	for (const [i, f] of CODE_FINDINGS.entries()) {
		await sql(
			`INSERT INTO security_audit_findings (id, org_id, target_id, fingerprint, verdict, overall_severity,
				estimated_severity, record, status, first_seen_run_id, last_seen_run_id, first_seen_ref, last_seen_ref,
				fixed_run_id, status_reason, status_changed_by, status_changed_at, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'run-shop-1', 'run-shop-1', $10, $10, $11, $12, $13, $14, $15, $16)`,
			[
				`code-finding-${i}`,
				org,
				SECURITY_WORLD.shopTarget,
				f.fingerprint,
				f.verdict,
				f.overall,
				f.estimated,
				JSON.stringify(f.record),
				f.status,
				CI_WORLD.head,
				f.status === "fixed" ? "run-shop-1" : null,
				f.reason,
				f.reason === null ? null : "user_eval",
				f.reason === null ? null : at(5),
				at(24 * 10),
				at(25),
			],
		)
	}

	// One completed scan of the deployed commit; checkout runs it, so its findings are in production.
	const scanId = "5ec0a0d1-0000-4000-8000-0000000000a1"
	await sql(
		`INSERT INTO dependency_scans (id, org_id, repository_id, commit_sha, ref, trigger, default_branch_head, status,
			lockfiles, package_count, vulnerable_count, error, started_at, finished_at)
		 VALUES ($1, $2, $3, $4, 'main', 'push', true, 'completed', $5, 1240, 4, null, $6, $6)`,
		[
			scanId,
			org,
			SHOP_REPO,
			CI_WORLD.head,
			JSON.stringify([
				{
					path: "bun.lock",
					kind: "bun-lock",
					blobSha: "b1",
					packageCount: 1240,
					status: "parsed",
					message: null,
				},
			]),
			at(9),
		],
	)
	const packages = [
		{
			id: "a1000000000000000000000000000001",
			name: "next",
			version: "14.1.0",
			relation: "direct",
			advisory: "GHSA-f82v-jwr5-mffw",
			aliases: [SECURITY_WORLD.criticalCve],
			severity: "critical",
			summary: "Authorization bypass in Next.js middleware",
			fixedIn: "14.2.25",
		},
		{
			id: "a1000000000000000000000000000002",
			name: "axios",
			version: "1.6.0",
			relation: "transitive",
			advisory: "GHSA-8hc4-vh64-cxmj",
			aliases: ["CVE-2024-39338"],
			severity: "high",
			summary: "Server-side request forgery through protocol-relative URLs",
			fixedIn: "1.7.4",
		},
		{
			id: "a1000000000000000000000000000003",
			name: "cookie",
			version: "0.5.0",
			relation: "transitive",
			advisory: "GHSA-pxg6-pf52-xh8x",
			aliases: ["CVE-2024-47764"],
			severity: "medium",
			summary: "cookie accepts out-of-bounds characters in name, path and domain",
			fixedIn: "0.7.0",
		},
		{
			id: "a1000000000000000000000000000004",
			name: "vitest",
			version: "1.2.0",
			relation: "dev",
			advisory: "GHSA-9crc-q9x8-hgqq",
			aliases: ["CVE-2025-24964"],
			severity: "low",
			summary: "Remote code execution when the Vitest API server listens on a public address",
			fixedIn: "1.6.1",
		},
	] as const
	for (const p of packages) {
		await sql(
			`INSERT INTO dependency_scan_matches (scan_id, org_id, lockfile_path, ecosystem, package_name, version, relation,
				advisory_id, aliases, severity, summary, fixed_in)
			 VALUES ($1, $2, 'bun.lock', 'npm', $3, $4, $5, $6, $7, $8, $9, $10)`,
			[
				scanId,
				org,
				p.name,
				p.version,
				p.relation,
				p.advisory,
				JSON.stringify(p.aliases),
				p.severity,
				p.summary,
				p.fixedIn,
			],
		)
		await sql(
			`INSERT INTO dependency_findings (id, org_id, repository_id, lockfile_path, ecosystem, package_name, advisory_id,
				aliases, severity, summary, versions, fixed_in, relation, status, first_seen_scan_id, last_seen_scan_id,
				first_seen_sha, last_seen_sha, created_at, updated_at)
			 VALUES ($1, $2, $3, 'bun.lock', 'npm', $4, $5, $6, $7, $8, $9, $10, $11, 'open', $12, $12, $13, $13, $14, $15)`,
			[
				p.id,
				org,
				SHOP_REPO,
				p.name,
				p.advisory,
				JSON.stringify(p.aliases),
				p.severity,
				p.summary,
				JSON.stringify([p.version]),
				p.fixedIn,
				p.relation,
				scanId,
				CI_WORLD.head,
				at(24 * 12),
				at(9),
			],
		)
	}
}

// ---------------------------------------------------------------------------------------------
// Warehouse

const lastSeen = (hoursAgo: number) => wire(Date.now() - hoursAgo * HOUR)

const SIGNATURES = [
	{ signature: "/.env", service: "api-gateway", requests: 340, answered: 0, sources: 14 },
	{ signature: "/.git/", service: "api-gateway", requests: 120, answered: 0, sources: 9 },
	{ signature: "/wp-login.php", service: "api-gateway", requests: 910, answered: 0, sources: 22 },
	{ signature: "/.env", service: "legacy-admin", requests: 6, answered: 3, sources: 2 },
	{ signature: "/.git/", service: "legacy-admin", requests: 4, answered: 0, sources: 2 },
	{ signature: "/phpmyadmin", service: "legacy-admin", requests: 9, answered: 0, sources: 3 },
	{ signature: "/actuator/env", service: "billing", requests: 12, answered: 12, sources: 1 },
	{ signature: "../", service: "billing", requests: 40, answered: 0, sources: 4 },
	{ signature: "/.env", service: "marketing-site", requests: 80, answered: 80, sources: 11 },
	{ signature: "/.git/", service: "marketing-site", requests: 60, answered: 60, sources: 8 },
	{ signature: "/server-status", service: "marketing-site", requests: 30, answered: 30, sources: 5 },
	{ signature: "/phpmyadmin", service: "marketing-site", requests: 25, answered: 25, sources: 6 },
	{ signature: "", service: "api-gateway", requests: 2200, answered: 2150, sources: 3 },
]

const EXPOSED = [
	{
		service: "legacy-admin",
		host: "admin.acme.dev",
		path: "/.env",
		signature: "/.env",
		httpStatus: 200,
		requests: 3,
		hoursAgo: 7,
		trace: "e1000000000000000000000000000001",
	},
	{
		service: "billing",
		host: "billing.internal.acme.dev",
		path: "/actuator/env",
		signature: "/actuator/env",
		httpStatus: 200,
		requests: 12,
		hoursAgo: 30,
		trace: "e1000000000000000000000000000002",
	},
	{
		service: "marketing-site",
		host: "acme.dev",
		path: "/.env",
		signature: "/.env",
		httpStatus: 200,
		requests: 80,
		hoursAgo: 2,
		trace: "e1000000000000000000000000000003",
	},
	{
		service: "marketing-site",
		host: "acme.dev",
		path: "/.git/config",
		signature: "/.git/",
		httpStatus: 200,
		requests: 60,
		hoursAgo: 3,
		trace: "e1000000000000000000000000000004",
	},
]

const SOURCES = [
	{
		clientAddress: "185.220.101.4",
		requests: 1900,
		signatures: 41,
		scanner: "nuclei",
		userAgent:
			"Mozilla/5.0 (compatible; Nuclei - Open-source project (github.com/projectdiscovery/nuclei))",
		hoursAgo: 1,
	},
	{
		clientAddress: "45.83.64.1",
		requests: 640,
		signatures: 12,
		scanner: "",
		userAgent: "Mozilla/5.0 zgrab/0.x",
		hoursAgo: 5,
	},
	{
		clientAddress: "103.152.18.77",
		requests: 210,
		signatures: 6,
		scanner: "",
		userAgent: "python-requests/2.31.0",
		hoursAgo: 20,
	},
]

const RUNTIMES = [
	{
		service: "checkout",
		runtimeName: "nodejs",
		runtimeVersion: "18.19.0",
		executableName: "node",
		sdkLanguage: "nodejs",
		sdkName: "@maple-dev/effect-sdk",
		sdkVersion: "0.9.0",
		spans: 412_000,
	},
	{
		service: "api-gateway",
		runtimeName: "nodejs",
		runtimeVersion: "22.4.0",
		executableName: "node",
		sdkLanguage: "nodejs",
		sdkName: "opentelemetry",
		sdkVersion: "1.30.0",
		spans: 1_900_000,
	},
	{
		service: "legacy-admin",
		runtimeName: "cpython",
		runtimeVersion: "3.8.18",
		executableName: "python3",
		sdkLanguage: "python",
		sdkName: "opentelemetry",
		sdkVersion: "1.20.0",
		spans: 9_000,
	},
	{
		service: "billing",
		runtimeName: "cpython",
		runtimeVersion: "3.12.7",
		executableName: "python3",
		sdkLanguage: "python",
		sdkName: "opentelemetry",
		sdkVersion: "1.27.0",
		spans: 88_000,
	},
	{
		service: "cart",
		runtimeName: "nodejs",
		runtimeVersion: "22.6.0",
		executableName: "bun",
		sdkLanguage: "nodejs",
		sdkName: "opentelemetry",
		sdkVersion: "1.30.0",
		spans: 140_000,
	},
	{
		service: "edge-worker",
		runtimeName: "workerd",
		runtimeVersion: "",
		executableName: "",
		sdkLanguage: "nodejs",
		sdkName: "@maple-dev/effect-sdk",
		sdkVersion: "0.9.0",
		spans: 300_000,
	},
]

/** The probe request behind each answered-probe sample trace: one Server span, as the scanner saw it. */
const probeSpan = (row: (typeof EXPOSED)[number]) => ({
	traceId: row.trace,
	spanId: `${row.trace.slice(0, 15)}1`,
	parentSpanId: "",
	spanName: `GET ${row.path}`,
	rawSpanName: "GET",
	serviceName: row.service,
	spanKind: "Server",
	durationMs: 3,
	startTime: lastSeen(row.hoursAgo),
	statusCode: "Unset",
	statusMessage: "",
	spanAttributes: JSON.stringify({
		"http.request.method": "GET",
		"url.path": row.path,
		"server.address": row.host,
		"http.response.status_code": String(row.httpStatus),
		"http.response.body.size": row.service === "legacy-admin" ? "1184" : "214",
		"client.address": SOURCES[0]?.clientAddress ?? "",
		"user_agent.original": SOURCES[0]?.userAgent ?? "",
	}),
	resourceAttributes: JSON.stringify({
		"service.name": row.service,
		"deployment.environment.name": "production",
	}),
	relationship: "related",
})

export const securityFixtureRules = (): FixtureRule[] => [
	...EXPOSED.flatMap((row): FixtureRule[] => {
		const { relationship: _, ...span } = probeSpan(row)
		return [
			{ match: (sql) => readsTraceSpans(sql) && sql.includes(row.trace), rows: [probeSpan(row)] },
			// inspect_span's point lookup reads the same span without the trace-index seek.
			{ match: (sql) => /\bFROM traces\b/.test(sql) && sql.includes(row.trace), rows: [span] },
		]
	}),
	{
		match: (sql) => sql.includes("FROM scanner_requests") && sql.includes(" AS sampleTraceId"),
		rows: EXPOSED.map((row) => ({ ...row, sampleTraceId: row.trace, lastSeen: lastSeen(row.hoursAgo) })),
	},
	{
		match: (sql) => sql.includes("FROM scanner_requests") && sql.includes(" AS userAgent"),
		rows: SOURCES.map((row) => ({ ...row, lastSeen: lastSeen(row.hoursAgo) })),
	},
	{
		match: (sql) => sql.includes("FROM scanner_requests") && sql.includes(" AS bucket"),
		rows: [],
	},
	{
		match: (sql) => sql.includes("FROM scanner_requests"),
		rows: SIGNATURES.map((row) => ({ ...row, lastSeen: lastSeen(2) })),
	},
	{
		match: (sql) => sql.includes("FROM service_runtimes_hourly"),
		rows: RUNTIMES.map((row) => ({ ...row, environment: "production", lastSeen: lastSeen(1) })),
	},
	{
		// Running commits for the dependency production join: checkout serves the scanned commit.
		match: (sql) =>
			sql.includes(" AS commitSha") && sql.includes(" AS spanCount") && !sql.includes("lastSeen"),
		rows: [
			{
				serviceName: "checkout",
				environment: "production",
				commitSha: CI_WORLD.head,
				spanCount: 412_000,
			},
			{
				serviceName: "api-gateway",
				environment: "production",
				commitSha: "0000000000000000000000000000000000000abc",
				spanCount: 1_900_000,
			},
		],
	},
]

// ---------------------------------------------------------------------------------------------
// Release and advisory catalogs (endoflife.date, OSV), answered in place of the network

const RELEASES = new Map(
	Object.entries({
		nodejs: [
			{ name: "22", isEol: false, eolFrom: "2027-04-30", latest: "22.12.0" },
			{ name: "20", isEol: false, eolFrom: "2026-04-30", latest: "20.18.1" },
			{ name: "18", isEol: true, eolFrom: "2025-04-30", latest: "18.20.5" },
		],
		python: [
			{ name: "3.12", isEol: false, eolFrom: "2028-10-31", latest: "3.12.7" },
			{ name: "3.8", isEol: true, eolFrom: "2024-10-07", latest: "3.8.20" },
		],
		bun: [{ name: "1", isEol: false, eolFrom: null, latest: "1.1.38" }],
	}),
)

const OSV = new Map<string, ReadonlyArray<unknown>>(
	Object.entries({
		"node@18.19.0": [
			{
				id: "BIT-node-2025-23166",
				aliases: [SECURITY_WORLD.nodeCve],
				summary: "Improper error handling in async crypto operations can crash the process",
				database_specific: { severity: "HIGH" },
				affected: [{ ranges: [{ events: [{ introduced: "18.0.0" }, { fixed: "18.20.6" }] }] }],
			},
		],
		"node@22.4.0": [
			{
				id: "BIT-node-2024-27983",
				aliases: ["CVE-2024-27983"],
				summary: "HTTP/2 server race condition allows denial of service",
				database_specific: { severity: "CRITICAL" },
				affected: [{ ranges: [{ events: [{ introduced: "22.0.0" }, { fixed: "22.5.0" }] }] }],
			},
			{
				id: "BIT-node-2025-23166",
				aliases: [SECURITY_WORLD.nodeCve],
				summary: "Improper error handling in async crypto operations can crash the process",
				database_specific: { severity: "HIGH" },
				affected: [{ ranges: [{ events: [{ introduced: "22.0.0" }, { fixed: "22.12.0" }] }] }],
			},
		],
	}),
)

const decodeOsvQuery = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Struct({ package: Schema.Struct({ name: Schema.String }), version: Schema.String }),
	),
)

/** A `fetch` that answers the catalogs' hosts from fixtures and refuses every other request. */
export const securityCatalogFetch: typeof globalThis.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
	const eol = /^https:\/\/endoflife\.date\/api\/v1\/products\/([^/?]+)/.exec(url)
	if (eol !== null) {
		const releases = RELEASES.get(eol[1] ?? "")
		return releases === undefined
			? new Response("not found", { status: 404 })
			: json({ result: { releases: releases.map((r) => ({ ...r, latest: { name: r.latest } })) } })
	}
	if (url.startsWith("https://api.osv.dev/v1/query")) {
		const raw = init?.body ?? (input instanceof Request ? await input.text() : "{}")
		const text =
			typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : "{}"
		const body = decodeOsvQuery(text)
		return json({ vulns: OSV.get(`${body.package.name}@${body.version}`) ?? [] })
	}
	if (url.startsWith("https://api.github.com/")) return json([])
	return new Response("offline", { status: 503 })
}
