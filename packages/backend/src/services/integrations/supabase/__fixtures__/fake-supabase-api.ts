/**
 * An in-memory Supabase Management API for tests: OAuth token/revoke, `/v1/organizations`,
 * `/v1/projects`, the logs endpoint, the advisors, the read-only query endpoint and the v2 log drain
 * CRUD, with bodies shaped like live responses (2026-10-21). Provided per test through
 * `FetchHttpClient.Fetch`; tests steer it by mutating `state` between steps.
 */
import { createHash, randomUUID } from "node:crypto"

export const FAKE_CLIENT_ID = "6f1c1d1e-0b7a-4d8e-9a51-3c2b1a0f9e88"
export const FAKE_CLIENT_SECRET = "sba_fake_client_secret"
export const FAKE_ORG = { id: "jylmnjimcybytpydxgbu", slug: "jylmnjimcybytpydxgbu", name: "Acme" }

/** A `/v1/projects` item as the live API returns it. */
export const fakeProject = (ref: string, overrides: Record<string, unknown> = {}) => ({
	id: ref,
	ref,
	organization_id: FAKE_ORG.id,
	organization_slug: FAKE_ORG.slug,
	name: `project-${ref.slice(0, 4)}`,
	region: "us-east-1",
	created_at: "2026-10-21T15:51:59.0158Z",
	status: "ACTIVE_HEALTHY",
	database: {
		host: `db.${ref}.supabase.co`,
		version: "17.11.0.003",
		postgres_engine: "17",
		release_channel: "ga",
	},
	...overrides,
})

export interface FakeLogRow {
	readonly id: string
	readonly timestamp: string
	readonly source: string
	readonly event_message: string
	readonly log_attributes: Readonly<Record<string, string>>
}

/** `2026-10-21T17:48:12.0596` and `2026-10-21 17:48:12.059000` alike, as comparable text. */
const comparableTime = (value: string) => {
	const [seconds = "", fraction = ""] = value.replace("T", " ").split(".")
	return `${seconds}.${fraction.padEnd(6, "0")}`
}

/** Serves the SQL Maple sends: `timestamp >= '..' and timestamp < '..' order by timestamp, id limit N`. */
const runLogsQuery = (rows: ReadonlyArray<FakeLogRow>, sql: string) => {
	const from = /timestamp >= '([^']+)'/.exec(sql)?.[1]
	const to = /timestamp < '([^']+)'/.exec(sql)?.[1]
	const limit = Number(/limit (\d+)/.exec(sql)?.[1] ?? "100")
	return rows
		.filter(
			(row) =>
				(from === undefined || comparableTime(row.timestamp) >= comparableTime(from)) &&
				(to === undefined || comparableTime(row.timestamp) < comparableTime(to)),
		)
		.toSorted(
			(a, b) =>
				comparableTime(a.timestamp).localeCompare(comparableTime(b.timestamp)) ||
				a.id.localeCompare(b.id),
		)
		.slice(0, limit)
}

export interface FakeCall {
	readonly method: string
	readonly path: string
	readonly authorization: string | null
	readonly body: string
	/** The URL's query string, e.g. a logs query's `sql`. */
	readonly search: URLSearchParams
}

/** A stored `log_drain` resource, as the v2 list returns it (config included, secrets and all). */
export interface FakeLogDrain {
	readonly id: string
	readonly attributes: {
		readonly name: string
		readonly description?: string
		readonly backend_type: string
		readonly config: Readonly<Record<string, unknown>>
	}
}

/** Live-verified Free plan answer to a drain create (2026-10-21). */
export const PAYMENT_REQUIRED_BODY = {
	error: {
		code: "payment_required",
		message: "Payment Required",
		description: "This feature requires the Pro, Team, or Enterprise organization plan.",
	},
}

export interface FakeSupabaseState {
	organizations: Array<unknown>
	projects: Array<unknown>
	/** Access tokens the API currently accepts; any other bearer answers 401. */
	validAccessTokens: Set<string>
	/** Set from the authorize URL so the token endpoint can verify the PKCE verifier. */
	codeChallenge: string | null
	expiresIn: number
	omitRefreshToken: boolean
	/** Refresh answers 400 `invalid_grant` (the grant was revoked upstream). */
	refreshRevoked: boolean
	/** Issued access tokens are not accepted (the API rejects a freshly minted token). */
	rejectIssuedTokens: boolean
	/** Forces `/v1/projects` to answer this status (e.g. 429). */
	projectsStatus: number | null
	/** Rows of the unified `logs` table, served by the logs endpoint for any project. */
	logs: Array<FakeLogRow>
	/** Forces the logs endpoint to answer this status (e.g. 429). */
	logsStatus: number | null
	/** Makes the logs endpoint answer 200 `{ "error": ... }`, as it does for a refused query. */
	logsQueryError: string | null
	/** `lints` served by `/advisors/performance` and `/advisors/security`. */
	advisors: { performance: Array<unknown>; security: Array<unknown> }
	/** Forces both advisor endpoints to answer this status (e.g. 429). */
	advisorsStatus: number | null
	/** Rows the read-only query endpoint answers with, whatever the SQL. */
	readOnlyRows: Array<unknown>
	/** Makes the read-only query endpoint answer 400 `{ message }`, as it does for a refused query. */
	readOnlyError: string | null
	/** Drains per project ref; seed one to model a drain set up in the Supabase dashboard. */
	drains: Map<string, Array<FakeLogDrain>>
	/** Forces drain creates to answer this status (402 answers the live Free plan body). */
	drainCreateStatus: number | null
	/** Stores the drain, then answers 502: a create Maple never hears succeed. */
	drainCreateFailsAfterStore: boolean
	/** Runs after a drain create is stored and before it answers, e.g. to land a concurrent disable. */
	afterDrainCreate: (() => Promise<void>) | null
	/** Forces drain listings to answer this status. */
	drainListStatus: number | null
	/** Forces drain deletes to answer this status. */
	drainDeleteStatus: number | null
	issued: number
	readonly calls: Array<FakeCall>
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	})

const expectedBasic = `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString("base64")}`

export const makeFakeSupabase = (initial: Partial<FakeSupabaseState> = {}) => {
	const state: FakeSupabaseState = {
		organizations: [FAKE_ORG],
		projects: [],
		validAccessTokens: new Set(),
		codeChallenge: null,
		expiresIn: 86_400,
		omitRefreshToken: false,
		refreshRevoked: false,
		rejectIssuedTokens: false,
		projectsStatus: null,
		logs: [],
		logsStatus: null,
		logsQueryError: null,
		advisors: { performance: [], security: [] },
		advisorsStatus: null,
		readOnlyRows: [],
		readOnlyError: null,
		drains: new Map(),
		drainCreateStatus: null,
		drainCreateFailsAfterStore: false,
		afterDrainCreate: null,
		drainListStatus: null,
		drainDeleteStatus: null,
		issued: 0,
		calls: [],
		...initial,
	}

	const issueTokens = () => {
		state.issued += 1
		const accessToken = `sbp_oauth_access_${state.issued}`
		if (!state.rejectIssuedTokens) state.validAccessTokens.add(accessToken)
		const tokens = { access_token: accessToken, expires_in: state.expiresIn, token_type: "Bearer" }
		return json(state.omitRefreshToken ? tokens : { ...tokens, refresh_token: `refresh_${state.issued}` })
	}

	const tokenEndpoint = (request: Request, body: string) => {
		if (request.headers.get("authorization") !== expectedBasic) {
			return json({ error: "invalid_client" }, 401)
		}
		const params = new URLSearchParams(body)
		if (params.get("grant_type") === "refresh_token") {
			// Live-verified: Supabase answers 404 for a revoked or rotated-away refresh token.
			return state.refreshRevoked
				? json({ message: "No such refresh token found" }, 404)
				: issueTokens()
		}
		const verifier = params.get("code_verifier") ?? ""
		const challenge = createHash("sha256").update(verifier).digest("base64url")
		if (params.get("grant_type") !== "authorization_code" || challenge !== state.codeChallenge) {
			return json({ error: "invalid_grant" }, 400)
		}
		return issueTokens()
	}

	const authorized = (request: Request) =>
		state.validAccessTokens.has((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""))

	const handle = (request: Request, body: string): Response => {
		const url = new URL(request.url)
		const path = url.pathname
		state.calls.push({
			method: request.method,
			path,
			authorization: request.headers.get("authorization"),
			body,
			search: url.searchParams,
		})
		if (path === "/v1/oauth/token" && request.method === "POST") return tokenEndpoint(request, body)
		if (path === "/v1/oauth/revoke" && request.method === "POST") {
			state.validAccessTokens.clear()
			return new Response(null, { status: 204 })
		}
		if (!authorized(request)) return json({ message: "Unauthorized" }, 401)
		if (path === "/v1/organizations") return json(state.organizations)
		if (path === "/v1/projects") {
			return state.projectsStatus === null
				? json(state.projects)
				: json({ message: "Too many requests" }, state.projectsStatus, { "x-ratelimit-reset": "42" })
		}
		if (/^\/v1\/projects\/[a-z]{20}\/analytics\/endpoints\/logs$/.test(path)) {
			if (state.logsStatus !== null) {
				return json({ message: "ThrottlerException: Too Many Requests" }, state.logsStatus, {
					"x-ratelimit-reset": "60",
				})
			}
			if (state.logsQueryError !== null) return json({ error: state.logsQueryError })
			return json({ result: runLogsQuery(state.logs, url.searchParams.get("sql") ?? "") })
		}
		const advisor = /^\/v1\/projects\/[a-z]{20}\/advisors\/(performance|security)$/.exec(path)?.[1]
		if (advisor === "performance" || advisor === "security") {
			if (state.advisorsStatus !== null) {
				return json({ message: "Too many requests" }, state.advisorsStatus, {
					"x-ratelimit-reset": "60",
				})
			}
			return json({ lints: state.advisors[advisor] })
		}
		if (
			/^\/v1\/projects\/[a-z]{20}\/database\/query\/read-only$/.test(path) &&
			request.method === "POST"
		) {
			// Live-verified: a refused statement answers 400 with the Postgres message.
			if (state.readOnlyError !== null) return json({ message: state.readOnlyError }, 400)
			return json(state.readOnlyRows, 201)
		}
		const drainPath = /^\/v2\/projects\/([a-z]{20})\/analytics\/log-drains(?:\/([^/]+))?$/.exec(path)
		if (drainPath !== null) return logDrains(request.method, drainPath[1] ?? "", drainPath[2], body)
		return json({ message: "Not found" }, 404)
	}

	const logDrains = (method: string, ref: string, id: string | undefined, body: string): Response => {
		const drains = state.drains.get(ref) ?? []
		if (id === undefined && method === "GET") {
			if (state.drainListStatus !== null) return json({ message: "Failed" }, state.drainListStatus)
			return json({ data: drains.map((drain) => ({ type: "log_drain", ...drain })) })
		}
		if (id === undefined && method === "POST") {
			if (state.drainCreateStatus === 402) return json(PAYMENT_REQUIRED_BODY, 402)
			if (state.drainCreateStatus !== null) return json({ message: "Failed" }, state.drainCreateStatus)
			const parsed: { data: { attributes: FakeLogDrain["attributes"] } } = JSON.parse(body)
			const drain: FakeLogDrain = { id: randomUUID(), attributes: parsed.data.attributes }
			state.drains.set(ref, [...drains, drain])
			if (state.drainCreateFailsAfterStore) return json({ message: "Bad gateway" }, 502)
			return json({ data: { type: "log_drain", ...drain } }, 201)
		}
		if (id !== undefined && method === "DELETE") {
			if (state.drainDeleteStatus !== null) return json({ message: "Failed" }, state.drainDeleteStatus)
			if (!drains.some((drain) => drain.id === id)) return json({ message: "Not found" }, 404)
			state.drains.set(
				ref,
				drains.filter((drain) => drain.id !== id),
			)
			return new Response(null, { status: 204 })
		}
		return json({ message: "Not found" }, 404)
	}

	const fetch: typeof globalThis.fetch = async (input, init) => {
		const requestInit: RequestInit & { readonly duplex: "half" } = { ...init, duplex: "half" }
		const request = new Request(input, requestInit)
		const body = await request.text()
		const response = handle(request, body)
		const created =
			request.method === "POST" && new URL(request.url).pathname.endsWith("/analytics/log-drains")
		if (created && state.afterDrainCreate !== null) await state.afterDrainCreate()
		return response
	}

	return { state, fetch }
}
