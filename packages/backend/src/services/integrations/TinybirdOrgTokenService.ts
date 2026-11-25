import { createHash } from "node:crypto"
import { TinybirdOrgTokenConfigError, TinybirdOrgTokenMintError, type OrgId } from "@maple/domain"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Redacted, String as Str } from "effect"
import {
	datasourcesMentionedIn,
	listOrgScopedDatasourceNames,
	listTrustedReadDatasourceNames,
} from "@maple/backend/services/warehouse/warehouse-catalog"
import { mintOrgReadJwt, type OrgReadJwtUse } from "@maple/backend/services/auth/tinybird-jwt"
import { readBoundsOf, readHorizonKey } from "@maple/backend/services/auth/tinybird-read-horizon"
import { RetentionService } from "@maple/backend/services/retention/RetentionService"
import { Env } from "@maple/backend/platform/Env"

// Per-org Tinybird read JWTs scope a read to one org's rows (row-level security enforced by
// Tinybird; see services/auth/tinybird-jwt.ts): always for raw SQL, and for every one of Maple's own
// compiled tenant reads where managed reads are Tinybird and the signing key is set. A cache entry expires SKEW seconds
// early, so a cached Tinybird client (30s executor cache) never outlives its JWT.
//
// The same filter carries the org's retention read horizon (services/auth/tinybird-read-horizon.ts):
// a signal the org set a period for is cut at that many days on its raw tables, for every reader
// of this token. An org that set nothing keeps the bare org filter.

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
		/**
		 * For a caller limited to part of the org's rows: the condition each datasource is kept to.
		 * A datasource with no condition is left out of the token.
		 */
		rowFilters?: ReadonlyMap<string, string>,
	) => Effect.Effect<string, TinybirdOrgTokenConfigError | TinybirdOrgTokenMintError>
}

export class TinybirdOrgTokenService extends Context.Service<
	TinybirdOrgTokenService,
	TinybirdOrgTokenServiceApi
>()("@maple/backend/services/TinybirdOrgTokenService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const retention = yield* RetentionService
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
		const namedIn = (statement: string, names: ReadonlyArray<string>): ReadonlyArray<string> => {
			const named = datasourcesMentionedIn(statement, names)
			// A statement that reads no datasource Maple knows gets the whole list, as before.
			return named.length === 0 ? names : named
		}

		// What a limited token is kept to, as a cache key: the exact condition of each datasource it
		// lists, hashed. Two callers share a token only when every one of those conditions is the same.
		const limitKey = (names: ReadonlyArray<string>, rowFilters: ReadonlyMap<string, string>): string =>
			createHash("sha256")
				.update(
					Arr.join(
						Arr.map(names, (name) => `${name}\u0000${rowFilters.get(name) ?? "\u0001"}`),
						"\u0002",
					),
				)
				.digest("hex")

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
			rowFilters?: ReadonlyMap<string, string>,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.use", use)
			const datasourceNames =
				statement === undefined
					? datasourceNamesFor[use]
					: namedIn(statement, datasourceNamesFor[use])
			yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.scopes", datasourceNames.length)
			const nowMs = yield* Clock.currentTimeMillis
			// Served from its own cache, and it never fails: a policy that cannot be read
			// falls back there, so the read itself goes on.
			const horizon = yield* retention.readHorizon(orgId)
			// Tokens differ by use (their name), by the datasources they list, by the read horizon
			// (a changed policy mints a new token instead of waiting out the old one) and by the rows
			// a limited caller is kept to: an unlimited token is never the answer for a limited one.
			const cacheKey = `${use}:${orgId}:${
				statement === undefined ? "*" : Arr.join(datasourceNames, ",")
			}:${readHorizonKey(horizon)}${
				rowFilters === undefined ? "" : `:limited:${limitKey(datasourceNames, rowFilters)}`
			}`
			yield* Effect.annotateCurrentSpan("maple.tinybird.jwt.limited", rowFilters !== undefined)
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
			const readBounds = readBoundsOf(horizon)
			if (Option.isNone(readBounds)) {
				return yield* new TinybirdOrgTokenMintError({
					message: "The org's retention read horizon is not a whole number of days",
					cause: readHorizonKey(horizon),
				})
			}
			yield* Effect.annotateCurrentSpan(
				"maple.tinybird.jwt.read_bounded_scopes",
				Arr.filter(datasourceNames, (name) => readBounds.value.has(name)).length,
			)
			const token = yield* Effect.try({
				try: () =>
					mintOrgReadJwt({
						signingKey,
						workspaceId,
						orgId,
						datasourceNames,
						readBounds: readBounds.value,
						rowFilters,
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
	/** For a caller that provides its own `RetentionService`. */
	static readonly layerWithoutDependencies = Layer.effect(this, this.make)
	static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(RetentionService.layer))
}
