/**
 * `bun scripts/preview-seed-smoke.ts [--skip-seed]`: seed and smoke-test a PR preview.
 *
 * Mints a Clerk session for the dev test user (development instance only), seeds
 * demo telemetry through the API, then hits read endpoints that touch Postgres and
 * the warehouse. Any 5xx or network error exits 1. Tokens are never printed.
 *
 * Env: API_URL, WEB_URL, CLERK_SECRET_KEY, optional PREVIEW_SEED_ORG_ID and
 * PREVIEW_SEED_EMAIL.
 */
const CLERK_API = "https://api.clerk.com/v1"
const DEFAULT_EMAIL = "david+clerk_test@gmail.com"
const TOKEN_TTL_SECONDS = 1800
const HEALTH_DEADLINE_MS = 180_000
const REQUEST_TIMEOUT_MS = 60_000

const skipSeed = process.argv.includes("--skip-seed")

const missing = ["API_URL", "WEB_URL", "CLERK_SECRET_KEY"].filter((name) => !process.env[name])
if (missing.length > 0) {
	console.error(`Missing required env: ${missing.join(", ")}`)
	process.exit(2)
}
const apiUrl = process.env.API_URL!.replace(/\/+$/, "")
const webUrl = process.env.WEB_URL!.replace(/\/+$/, "")
const secretKey = process.env.CLERK_SECRET_KEY!
if (!secretKey.startsWith("sk_test_")) {
	console.error("CLERK_SECRET_KEY is not a development key (sk_test_...). Refusing to mint a session.")
	process.exit(2)
}
const email = process.env.PREVIEW_SEED_EMAIL ?? DEFAULT_EMAIL

const fail = (message: string): never => {
	console.error(`::error::${message}`)
	process.exit(1)
}

const clerkFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
	const response = await fetch(`${CLERK_API}${path}`, {
		...init,
		headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
	})
	if (!response.ok) {
		// Clerk error bodies carry codes and messages, never the secret.
		fail(`Clerk ${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`)
	}
	return (await response.json()) as T
}

const timedFetch = (url: string, init?: RequestInit) =>
	fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

// 1. Wait for the API to come up; a fresh Worker can take a moment to route.
const waitForHealth = async () => {
	const startedAt = Date.now()
	let delayMs = 2_000
	let last = "no attempt"
	while (Date.now() - startedAt < HEALTH_DEADLINE_MS) {
		const outcome = await timedFetch(`${apiUrl}/health`).then(
			(response) => (response.status === 200 ? "ok" : `HTTP ${response.status}`),
			(error: unknown) => `network error: ${String(error)}`,
		)
		if (outcome === "ok") return
		last = outcome
		await Bun.sleep(delayMs)
		delayMs = Math.min(delayMs * 2, 20_000)
	}
	fail(`${apiUrl}/health did not return 200 within ${HEALTH_DEADLINE_MS / 1000}s (last: ${last})`)
}

await waitForHealth()
console.log(`API healthy: ${apiUrl}`)

// 2. A session with an active org: the internal API takes the tenant from the token's org claim.
const users = await clerkFetch<Array<{ id: string }>>(`/users?email_address=${encodeURIComponent(email)}`)
const user = users[0] ?? fail(`No user with email ${email} on this Clerk instance.`)

const resolveOrgId = async (): Promise<string> => {
	if (process.env.PREVIEW_SEED_ORG_ID) return process.env.PREVIEW_SEED_ORG_ID
	const memberships = await clerkFetch<{ data: Array<{ organization: { id: string } }> }>(
		`/users/${user.id}/organization_memberships?limit=1`,
	)
	return memberships.data[0]?.organization.id ?? fail(`${email} is not a member of any organization.`)
}
const orgId = await resolveOrgId()

// `POST /sessions` is testing-only on Clerk and unavailable on production instances.
const session = await clerkFetch<{ id: string }>("/sessions", {
	method: "POST",
	body: JSON.stringify({ user_id: user.id, active_organization_id: orgId }),
})
const { jwt: token } = await clerkFetch<{ jwt: string }>(`/sessions/${session.id}/tokens`, {
	method: "POST",
	body: JSON.stringify({ expires_in_seconds: TOKEN_TTL_SECONDS }),
})
console.log(`Session minted for ${email} in org ${orgId}`)

const results: Array<{ name: string; status: string; ok: boolean }> = []

const call = async (name: string, method: "GET" | "POST", path: string, body?: unknown) => {
	const headers = new Headers({ authorization: `Bearer ${token}` })
	if (body !== undefined) headers.set("content-type", "application/json")
	const outcome = await timedFetch(`${apiUrl}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	}).then(
		// 401 means the session never reached a tenant, which would mask every other check.
		async (response) => ({
			status: String(response.status),
			ok: response.status < 500 && response.status !== 401,
			text: await response.text(),
		}),
		(error: unknown) => ({ status: `network error: ${String(error)}`, ok: false, text: "" }),
	)
	results.push({ name: `${method} ${name}`, status: outcome.status, ok: outcome.ok })
	return outcome
}

// 3. Seed. Ingest keys are created on first read, so the GET below provisions them.
if (!skipSeed) {
	const seeded = await call("/internal/demo/seed", "POST", "/internal/demo/seed", { hours: 6 })
	if (seeded.status !== "200") fail(`Demo seed returned ${seeded.status}: ${seeded.text.slice(0, 500)}`)
	console.log(`Seed: ${seeded.text}`)
}

// 4. Smoke reads across Postgres (keys, dashboards, alerts) and the warehouse.
const endTime = new Date()
const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000)
const window = { start_time: startTime.toISOString(), end_time: endTime.toISOString() }

await call("/v2/ingest_keys", "GET", "/v2/ingest_keys")
await call("/v2/dashboards", "GET", "/v2/dashboards?limit=10")
await call("/v2/alerts/rules", "GET", "/v2/alerts/rules?limit=10")
await call("/v2/services", "GET", `/v2/services?${new URLSearchParams({ ...window, limit: "10" })}`)
await call("/v2/traces/search", "POST", "/v2/traces/search", { ...window, limit: 10 })
await call("/v2/logs/search", "POST", "/v2/logs/search", { ...window, limit: 10 })

const web = await timedFetch(webUrl).then(
	(response) => ({ status: String(response.status), ok: response.status === 200 }),
	(error: unknown) => ({ status: `network error: ${String(error)}`, ok: false }),
)
results.push({ name: `GET ${webUrl}`, status: web.status, ok: web.ok })

// Best effort: the session is throwaway, revoke it so it does not linger.
await fetch(`${CLERK_API}/sessions/${session.id}/revoke`, {
	method: "POST",
	headers: { authorization: `Bearer ${secretKey}` },
}).catch(() => undefined)

const width = Math.max(...results.map((r) => r.name.length))
console.log(`\n     ${"Endpoint".padEnd(width)}  Status`)
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(width)}  ${r.status}`)

const failed = results.filter((r) => !r.ok)
if (failed.length > 0) fail(`${failed.length} preview smoke check(s) failed`)
console.log("\nPreview smoke test passed.")
