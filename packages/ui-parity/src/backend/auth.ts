import { Option, Schema } from "effect"
import type { Dataset } from "../fixtures/dataset.ts"

/**
 * Self-hosted session tokens for the fixture. JWT-shaped so the web app's `readJwtExpMs` reads the
 * `exp` it renews against, with a fixed signature so the same dataset always gets the same token.
 */

/** Far enough past the frozen clock that the app never tries to renew during a capture. */
const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

const base64Url = (value: string) => Buffer.from(value, "utf8").toString("base64url")

const TokenClaims = Schema.Struct({
	sub: Schema.String,
	org_id: Schema.String,
	dataset: Schema.String,
	exp: Schema.Number,
})
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(TokenClaims))

export interface FixtureSession {
	readonly token: string
	readonly expiresAt: number
	readonly sessionExpiresAt: number
}

export const fixtureSession = (dataset: Dataset): FixtureSession | undefined => {
	if (dataset.identity === null) return undefined
	const nowMs = new Date(dataset.now).getTime()
	const expiresAt = nowMs + TOKEN_LIFETIME_MS
	const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
	const claims = base64Url(
		JSON.stringify({
			sub: dataset.identity.userId,
			org_id: dataset.identity.orgId,
			dataset: dataset.name,
			exp: Math.floor(expiresAt / 1000),
		}),
	)
	return {
		token: `${header}.${claims}.parity-fixture`,
		expiresAt,
		sessionExpiresAt: nowMs + SESSION_LIFETIME_MS,
	}
}

/**
 * Self-hosted: a fixture token minted for this dataset's org. Clerk: any bearer, since the
 * `window.Clerk` stub mints its own and the identity comes from the dataset either way.
 */
export const acceptsBearer = (dataset: Dataset, bearer: string): boolean => {
	if (dataset.identity === null || bearer.length === 0) return false
	if (dataset.auth === "clerk") return true
	const claims = bearer.split(".")[1]
	if (claims === undefined) return false
	return Option.match(decodeClaims(Buffer.from(claims, "base64url").toString("utf8")), {
		onNone: () => false,
		onSome: (decoded) => decoded.org_id === dataset.identity?.orgId,
	})
}
