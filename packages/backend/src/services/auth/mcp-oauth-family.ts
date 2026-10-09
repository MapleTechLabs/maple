import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleOrm, MapleOrmError } from "@maple/db/client"
import { ApiKeys, McpOAuthRefreshTokens } from "@maple/db/tables"
import type { ApiKeyId, OrgId, UserId } from "@maple/domain/http"
import { Effect } from "effect"

/**
 * Refresh-family revocation, shared rather than private to `McpOAuthService`.
 *
 * A family is the durable half of an MCP grant: the visible `api_keys` row is
 * re-minted hourly, so flipping `revoked` on it alone is a no-op the next
 * rotation undoes. Every path that ends a grant (reuse detection, the OAuth
 * revocation endpoint, the API-keys UI, and a member losing their membership)
 * has to come through here. Run them inside the caller's transaction.
 */

/** Revoke a whole family and every access key it has ever minted. */
export const revokeRefreshFamily = (
	orm: MapleOrm,
	familyId: string,
	now: number,
): Effect.Effect<void, MapleOrmError> =>
	Effect.gen(function* () {
		const family = yield* orm.run(
			PG.from(McpOAuthRefreshTokens)
				.select("accessKeyId")
				.where(($) => [$.familyId.eq(familyId)]),
		)
		yield* orm.run(
			PG.update(McpOAuthRefreshTokens)
				.set({ revokedAt: now })
				.where(($) => [$.familyId.eq(familyId), $.revokedAt.isNull()]),
		)
		const [first, ...rest] = family.map((item) => item.accessKeyId)
		if (first !== undefined) {
			yield* orm.run(
				PG.update(ApiKeys)
					.set({ revoked: true, revokedAt: now })
					.where(($) => [$.id.in_(first, ...rest)]),
			)
		}
	})

const revokeFamilies = (
	orm: MapleOrm,
	rows: ReadonlyArray<{ readonly familyId: string }>,
	now: number,
): Effect.Effect<number, MapleOrmError> => {
	const familyIds = [...new Set(rows.map((row) => row.familyId))]
	return Effect.forEach(familyIds, (familyId) => revokeRefreshFamily(orm, familyId, now), {
		discard: true,
	}).pipe(Effect.as(familyIds.length))
}

/**
 * Revoke every family reachable from these access-key ids. This is the bridge
 * from "the user revoked the key they can see" to "the grant behind it dies".
 */
export const revokeFamiliesForAccessKeys = (
	orm: MapleOrm,
	accessKeyIds: ReadonlyArray<ApiKeyId>,
	now: number,
): Effect.Effect<number, MapleOrmError> => {
	const [first, ...rest] = accessKeyIds
	if (first === undefined) return Effect.succeed(0)
	return Effect.flatMap(
		orm.run(
			PG.from(McpOAuthRefreshTokens)
				.select("familyId")
				.where(($) => [$.accessKeyId.in_(first, ...rest)]),
		),
		(rows) => revokeFamilies(orm, rows, now),
	)
}

/** Revoke every family a user holds in one organization, or in all of them when `orgId` is null. */
export const revokeRefreshFamiliesForMember = (
	orm: MapleOrm,
	orgId: OrgId | null,
	userId: UserId,
	now: number,
): Effect.Effect<number, MapleOrmError> =>
	Effect.flatMap(
		orm.run(
			PG.from(McpOAuthRefreshTokens)
				.select("familyId")
				.where(($) => [orgId === null ? undefined : $.orgId.eq(orgId), $.userId.eq(userId)]),
		),
		(rows) => revokeFamilies(orm, rows, now),
	)
