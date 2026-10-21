/**
 * An in-memory Supabase Management API for tests: OAuth token/revoke plus `/v1/organizations` and
 * `/v1/projects`, with bodies shaped like live responses (2026-10-21). Provided per test through
 * `FetchHttpClient.Fetch`; tests steer it by mutating `state` between steps.
 */
import { createHash } from "node:crypto"

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

export interface FakeCall {
	readonly method: string
	readonly path: string
	readonly authorization: string | null
	readonly body: string
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
		const path = new URL(request.url).pathname
		state.calls.push({
			method: request.method,
			path,
			authorization: request.headers.get("authorization"),
			body,
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
		return json({ message: "Not found" }, 404)
	}

	const fetch: typeof globalThis.fetch = async (input, init) => {
		const requestInit: RequestInit & { readonly duplex: "half" } = { ...init, duplex: "half" }
		const request = new Request(input, requestInit)
		const body = await request.text()
		return handle(request, body)
	}

	return { state, fetch }
}
