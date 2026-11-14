import { TinybirdOrgTokenConfigError, TinybirdOrgTokenMintError, type OrgId } from "@maple/domain"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Redacted, String as Str } from "effect"
import {
	listOrgScopedDatasourceNames,
	listTrustedReadDatasourceNames,
} from "@maple/backend/services/warehouse/warehouse-catalog"
import { mintOrgReadJwt, type OrgReadJwtUse } from "@maple/backend/services/auth/tinybird-jwt"
import { Env } from "@maple/backend/platform/Env"

// Per-org Tinybird read JWTs scope a read to one org's rows (row-level security enforced by
// Tinybird; see services/auth/tinybird-jwt.ts): always for raw SQL, and for Maple's own compiled
// reads where `MAPLE_WAREHOUSE_ORG_SCOPED_READS` is on. A cache entry expires SKEW seconds
// early, so a cached Tinybird client (30s executor cache) never outlives its JWT.

const JWT_TTL_SECONDS = 600
/** Re-mint this many seconds before true expiry (must exceed the executor's 30s client cache). */
const JWT_REFRESH_SKEW_SECONDS = 60
/**
 * Each token carries one scope per OrgId-bearing datasource, so an unbounded
 * org map can consume meaningful isolate memory. Eviction only causes a cheap
 * local re-mint; it does not invalidate the previously issued JWT.
 */
export const JWT_CACHE_MAX_ENTRIES = 512

export interface TinybirdOrgTokenServiceApi {
	/**
	 * A Tinybird read JWT scoped to `orgId` across every OrgId-bearing datasource. `use` picks the
	 * rate bucket (`raw-sql` when unset); the row filter is the same for both. Given the
	 * `statement` it is for, the token carries only the datasources that statement names.
	 */
	readonly getOrgReadToken: (
		orgId: OrgId,
		use?: OrgReadJwtUse,
		statement?: string,
	) => Effect.Effect<string, TinybirdOrgTokenConfigError | TinybirdOrgTokenMintError>
}

export class TinybirdOrgTokenService extends Context.Service<
	TinybirdOrgTokenService,
	TinybirdOrgTokenServiceApi
>()("@maple/backend/services/TinybirdOrgTokenService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		// The scope allowlists are static per deploy — compute them once. Maple's own reads also
		// reach the datasources raw SQL is kept out of (the audit log), so they get the wider list.
		const datasourceNamesFor = {
			"raw-sql": listOrgScopedDatasourceNames(),
			"trusted-read": listTrustedReadDatasourceNames(),
		} satisfies Record<OrgReadJwtUse, ReadonlyArray<string>>
		// Tinybird spends time on every scope a token carries, whatever the query reads: measured
		// on the query API and the gateway, 54 scopes add about 100 ms to each request and one adds
		// nothing. So a token for a known statement lists only the datasources named in it. A name
		// that only appears inside a string literal adds a scope, still filtered to the org.
		// A whole identifier, so `traces` is not found inside `traces_aggregates_hourly`.
		const mentions = new Map(
			Arr.map(
				datasourceNamesFor["trusted-read"],
				(name) => [name, new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`)] as const,
			),
		)
		const namedIn = (statement: string, names: ReadonlyArray<string>): ReadonlyArray<string> => {
			const named = Arr.filter(names, (name) => mentions.get(name)?.test(statement) === true)
			// A statement that reads no datasource Maple knows gets the whole list, as before.
			return named.length === 0 ? names : named
		}

		// Per-instance (per-isolate) cache. `expiresAt` is the re-mint deadline in ms.
		const cache = new Map<string, { token: string; expiresAt: number }>()
		const pruneCache = (nowMs: number) => {
			for (const [key, entry] of cache) {
				if (entry.expiresAt <= nowMs) cache.delete(key)
			}
			while (cache.size >= JWT_CACHE_MAX_ENTRIES) {
				const oldestKey = cache.keys().next().value
				if (oldestKey === undefined) break
				cache.delete(oldestKey)
			}
		}

		const getOrgReadToken = Effect.fn("TinybirdOrgTokenService.getOrgReadToken")(function* (
			orgId: OrgId,
			use: OrgReadJwtUse = "raw-sql",
			statement?: string,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.use", use)
			const datasourceNames =
				statement === undefined
					? datasourceNamesFor[use]
					: namedIn(statement, datasourceNamesFor[use])
			yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.scopes", datasourceNames.length)
			const nowMs = yield* Clock.currentTimeMillis
			// Tokens differ by use (their name) and by the datasources they list.
			const cacheKey = `${use}:${orgId}:${
				statement === undefined ? "*" : Arr.join(datasourceNames, ",")
			}`
			const cached = cache.get(cacheKey)
			if (cached !== undefined && cached.expiresAt > nowMs) {
				// Map iteration order is insertion order; refresh it on access so the
				// fixed-size cache evicts the least-recently-used org.
				cache.delete(cacheKey)
				cache.set(cacheKey, cached)
				yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.cache_hit", true)
				return cached.token
			}
			yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.cache_hit", false)
			pruneCache(nowMs)
			if (Option.isNone(env.TINYBIRD_SIGNING_KEY)) {
				return yield* new TinybirdOrgTokenConfigError({
					setting: "SigningKey",
					message: "TINYBIRD_SIGNING_KEY is required for org-scoped Tinybird reads",
				})
			}
			if (
				Option.isNone(env.TINYBIRD_WORKSPACE_ID) ||
				Str.trim(env.TINYBIRD_WORKSPACE_ID.value) === ""
			) {
				return yield* new TinybirdOrgTokenConfigError({
					setting: "WorkspaceId",
					message: "TINYBIRD_WORKSPACE_ID is required for org-scoped Tinybird reads",
				})
			}
			const workspaceId = env.TINYBIRD_WORKSPACE_ID.value
			const signingKey = Redacted.value(env.TINYBIRD_SIGNING_KEY.value)
			if (Str.trim(signingKey) === "") {
				return yield* new TinybirdOrgTokenConfigError({
					setting: "SigningKey",
					message: "TINYBIRD_SIGNING_KEY must not be empty",
				})
			}
			const token = yield* Effect.try({
				try: () =>
					mintOrgReadJwt({
						signingKey,
						workspaceId,
						orgId,
						datasourceNames,
						nowSeconds: Math.floor(nowMs / 1000),
						ttlSeconds: JWT_TTL_SECONDS,
						use,
						// The ceiling is for SQL a customer wrote; Maple's own reads are not capped by it.
						rpsLimit:
							use === "raw-sql"
								? Option.getOrUndefined(env.TINYBIRD_RAW_SQL_JWT_RPS_LIMIT)
								: undefined,
					}),
				catch: (cause) =>
					new TinybirdOrgTokenMintError({
						message: "Failed to mint the Tinybird org-scoped read token",
						cause,
					}),
			})
			cache.set(cacheKey, {
				token,
				expiresAt: nowMs + (JWT_TTL_SECONDS - JWT_REFRESH_SKEW_SECONDS) * 1000,
			})
			return token
		})

		return { getOrgReadToken } satisfies TinybirdOrgTokenServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
