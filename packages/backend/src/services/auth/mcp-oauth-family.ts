import { apiKeys, mcpOAuthRefreshTokens } from "@maple/db"
import type { MapleDbLike } from "@maple/db/client"
import type { ApiKeyId, OrgId, UserId } from "@maple/domain/http"
import { and, eq, inArray, isNull } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Effect } from "effect"

/**
 * Refresh-family revocation, shared rather than private to `McpOAuthService`.
 *
 * A family is the durable half of an MCP grant: the visible `api_keys` row is
 * re-minted hourly, so flipping `revoked` on it alone is a no-op the next
 * rotation undoes. Every path that ends a grant — reuse detection, the OAuth
 * revocation endpoint, the API-keys UI, and a member losing their membership —
 * has to come through here.
 */

/** Revoke a whole family and every access key it has ever minted. */
export const revokeRefreshFamily = (
	tx: MapleDbLike,
	familyId: string,
	now: Date,
): Effect.Effect<void, EffectDrizzleQueryError> =>
	Effect.gen(function* () {
		const family = yield* tx
			.select({ accessKeyId: mcpOAuthRefreshTokens.accessKeyId })
			.from(mcpOAuthRefreshTokens)
			.where(eq(mcpOAuthRefreshTokens.familyId, familyId))
		yield* tx
			.update(mcpOAuthRefreshTokens)
			.set({ revokedAt: now })
			.where(and(eq(mcpOAuthRefreshTokens.familyId, familyId), isNull(mcpOAuthRefreshTokens.revokedAt)))
		const accessKeyIds = family.map((item) => item.accessKeyId)
		if (accessKeyIds.length > 0) {
			yield* tx
				.update(apiKeys)
				.set({ revoked: true, revokedAt: now })
				.where(inArray(apiKeys.id, accessKeyIds))
		}
	})

const revokeFamilies = (
	tx: MapleDbLike,
	rows: ReadonlyArray<{ readonly familyId: string }>,
	now: Date,
): Effect.Effect<number, EffectDrizzleQueryError> =>
	Effect.gen(function* () {
		const familyIds = [...new Set(rows.map((row) => row.familyId))]
		for (const familyId of familyIds) yield* revokeRefreshFamily(tx, familyId, now)
		return familyIds.length
	})

/**
 * Revoke every family reachable from these access-key ids. This is the bridge
 * from "the user revoked the key they can see" to "the grant behind it dies".
 */
export const revokeFamiliesForAccessKeys = (
	tx: MapleDbLike,
	accessKeyIds: ReadonlyArray<ApiKeyId>,
	now: Date,
): Effect.Effect<number, EffectDrizzleQueryError> =>
	accessKeyIds.length === 0
		? Effect.succeed(0)
		: Effect.flatMap(
				tx
					.select({ familyId: mcpOAuthRefreshTokens.familyId })
					.from(mcpOAuthRefreshTokens)
					.where(inArray(mcpOAuthRefreshTokens.accessKeyId, [...accessKeyIds])),
				(rows) => revokeFamilies(tx, rows, now),
			)

/** Revoke every family a user holds in one organization, or in all of them when `orgId` is null. */
export const revokeRefreshFamiliesForMember = (
	tx: MapleDbLike,
	orgId: OrgId | null,
	userId: UserId,
	now: Date,
): Effect.Effect<number, EffectDrizzleQueryError> =>
	Effect.flatMap(
		tx
			.select({ familyId: mcpOAuthRefreshTokens.familyId })
			.from(mcpOAuthRefreshTokens)
			.where(
				and(
					...(orgId === null ? [] : [eq(mcpOAuthRefreshTokens.orgId, orgId)]),
					eq(mcpOAuthRefreshTokens.userId, userId),
				),
			),
		(rows) => revokeFamilies(tx, rows, now),
	)
