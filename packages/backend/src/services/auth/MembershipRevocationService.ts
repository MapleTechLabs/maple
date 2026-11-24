import { EdgeCacheService } from "@maple/cache"
import type { MapleDb } from "@maple/db/client"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertDestinations,
	ApiKeys,
	ChatIdentities,
	CliDeviceAuthorizations,
	DashboardShares,
	DeviceCredentials,
	DigestSubscriptions,
	LiveActivities,
	McpOAuthAuthorizations,
	MobileDevices,
} from "@maple/db/tables"
import { RoleName, type OrgId, type UserId } from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Predicate, Result, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import {
	DestinationPublicConfigSchema,
	SecretConfigFromJson,
} from "@maple/backend/services/alerts/AlertDestinationHydration"
import { openSecret, sealSecret, secretKeyringFromEnv } from "@maple/backend/platform/SecretBox"
import { alertDestinationSecretSlot } from "@maple/backend/platform/secret-slots"
import { ORG_MEMBERSHIP_CACHE_BUCKET, forgetMembershipMemo } from "./OrgMembershipService"
import * as Policy from "@maple/domain/policy"
import { revokeFamiliesForAccessKeys, revokeRefreshFamiliesForMember } from "./mcp-oauth-family"
import { PinnedPermissionCodes, pinnedGrants } from "./pinned-authority"

/**
 * What has to happen the moment somebody stops being a member of an org.
 *
 * Nothing ran on removal before this existed, and five separate authorization
 * findings were all the same absence: the membership cache kept answering yes
 * for five minutes, and every *user-bound* credential minted for that person
 * (CLI keys, MCP grants, alert emails, push devices, share links, webhooks) never re-checked
 * membership at all, so the five-minute window was really "forever".
 *
 * Every step is idempotent and predicate-driven, so a webhook retry converges
 * rather than double-applying.
 */

export class MembershipRevocationError extends Schema.TaggedError<MembershipRevocationError>()(
	"@maple/backend/errors/MembershipRevocationError",
	{
		message: Schema.String,
		orgId: Schema.optionalKey(Schema.String),
		userId: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.String),
	},
) {}

export interface MembershipRevocationSummary {
	readonly apiKeysRevoked: number
	readonly mcpFamiliesRevoked: number
	readonly deviceCredentialsRevoked: number
	readonly cliAuthorizationsDeleted: number
	readonly mcpAuthorizationsDeleted: number
	readonly emailDestinationsUpdated: number
	readonly mobileDevicesDeleted: number
	readonly chatIdentitiesDeleted: number
	readonly digestSubscriptionsDisabled: number
	readonly dashboardSharesRevoked: number
	readonly alertDestinationsDisabled: number
}

export interface MembershipDemotionSummary {
	readonly apiKeysRevoked: number
	readonly mcpFamiliesRevoked: number
	readonly deviceCredentialsRevoked: number
	readonly dashboardSharesRevoked: number
	readonly digestSubscriptionsDisabled: number
	readonly mobileDevicesDeleted: number
}

export interface MembershipRevocationServiceApi {
	/**
	 * Evict the membership caches and retire everything that person held in the
	 * org. Cache eviction runs first and never fails: it closes the widest
	 * window even when the database work later errors and the delivery retries.
	 */
	readonly revokeMembership: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<MembershipRevocationSummary, MembershipRevocationError>
	/**
	 * The same sweep with no org filter, for `user.deleted`: Clerk's payload
	 * names no organizations and the memberships are already gone by the time it
	 * arrives, so the credential tables are the only remaining record of where
	 * that person had access.
	 */
	readonly revokeUser: (
		userId: UserId,
	) => Effect.Effect<MembershipRevocationSummary, MembershipRevocationError>
	/**
	 * A member's role changed (`organizationMembership.updated`, or a custom role rewritten): evict
	 * the caches, and retire every credential pinned to a permission `current` no longer holds.
	 * `current` is what the member holds now (`Policy.grantsOf(roles, custom)`): a promotion strips
	 * nothing.
	 */
	readonly demoteMembership: (
		orgId: OrgId,
		userId: UserId,
		current: Policy.Grants,
	) => Effect.Effect<MembershipDemotionSummary, MembershipRevocationError>
	/** Evict the membership caches only: the one step that never fails. */
	readonly invalidateMembership: (userId: UserId) => Effect.Effect<void>
}

const toRevocationError = (error: unknown) =>
	new MembershipRevocationError({
		message: error instanceof Error ? error.message : "Membership revocation failed",
	})

/**
 * The shape every role-bearing key metadata shares (`maple_cli`, `maple_mcp`,
 * `maple_mcp_oauth`, `maple_ios_widget`): the minting user's roles (and a custom
 * role's permission codes), frozen onto the key. `resolveByKey` reads them back with no membership recheck, which is
 * why a demotion has to come and take them away.
 */
const PinnedRoles = Schema.Struct({ roles: Schema.Array(RoleName), permissions: PinnedPermissionCodes })
const decodePinnedRoles = Schema.decodeUnknownOption(PinnedRoles)

const decodePublicConfig = Schema.decodeUnknownOption(DestinationPublicConfigSchema)
const decodeSecretConfig = Schema.decodeOption(SecretConfigFromJson)
const encodeSecretConfig = Schema.encodeEffect(SecretConfigFromJson)

// Shared by removal and demotion. `orgId` null is every org (`user.deleted`).

/** Disabled the way the daily Clerk reconcile disables a departed member: opt-out stamps stay. */
const disableDigests = (db: MapleDb, orgId: OrgId | null, userId: UserId, now: number) =>
	db.run(
		PG.update(DigestSubscriptions)
			.set({ enabled: false, webAnalyticsEnabled: false, updatedAt: now })
			.where(($) => [orgId === null ? undefined : $.orgId.eq(orgId), $.userId.eq(userId)])
			.returning("id"),
	)

/** A phone is pushed alert names, values and Live Activity series; its activities go with it. */
const deleteMobileDevices = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId | null, userId: UserId) {
	const deleted = yield* db.run(
		PG.deleteFrom(MobileDevices)
			.where(($) => [orgId === null ? undefined : $.orgId.eq(orgId), $.userId.eq(userId)])
			.returning("id"),
	)
	const [first, ...rest] = Arr.map(deleted, (row) => row.id)
	if (first !== undefined) {
		yield* db.run(PG.deleteFrom(LiveActivities).where(($) => [$.deviceId.in_(first, ...rest)]))
	}
	return deleted.length
})

/**
 * A share link serves the board to whoever holds it, with no membership check. Revoked, not
 * deleted: the row is the audit record of the link.
 */
const revokeShares = (db: MapleDb, orgId: OrgId | null, userId: UserId, now: number) =>
	db.run(
		PG.update(DashboardShares)
			.set({ revokedAt: now, updatedAt: now })
			.where(($) => [
				orgId === null ? undefined : $.orgId.eq(orgId),
				$.createdBy.eq(userId),
				$.revokedAt.isNull(),
			])
			.returning("id", "orgId"),
	)

/**
 * A webhook or chat destination the member pointed somewhere keeps delivering the org's alerts
 * there. Disabled with a reason so an admin can re-enable it.
 */
const disableDestinations = (
	db: MapleDb,
	orgId: OrgId | null,
	userId: UserId,
	now: number,
	disabledReason: string,
) =>
	db.run(
		PG.update(AlertDestinations)
			.set({ enabled: false, disabledAt: now, disabledReason, updatedAt: now })
			.where(($) => [
				orgId === null ? undefined : $.orgId.eq(orgId),
				$.createdBy.eq(userId),
				$.type.neq("email"),
				$.enabled.eq(true),
			])
			.returning("id", "orgId"),
	)

const make = Effect.gen(function* () {
	const database = yield* Database
	const env = yield* Env
	const edgeCache = yield* EdgeCacheService
	const audit = yield* AuditLogService
	const dbExecute = makeDbExecute(database, "MembershipRevocationService", toRevocationError)

	const keyring = yield* secretKeyringFromEnv(env, (message) => new MembershipRevocationError({ message }))

	const invalidateMembership = Effect.fn("MembershipRevocationService.invalidateMembership")(function* (
		userId: UserId,
	) {
		yield* Effect.annotateCurrentSpan({ "tenant.userId": userId })
		forgetMembershipMemo(userId)
		yield* edgeCache.invalidate({ bucket: ORG_MEMBERSHIP_CACHE_BUCKET, key: userId })
	})

	type Retired = ReadonlyArray<{ readonly id: string; readonly orgId: OrgId }>
	const recordRetired = (userId: UserId, shares: Retired, destinations: Retired, reason: string) =>
		Effect.forEach(
			[
				...Arr.map(shares, (row) => ({ row, action: "dashboard_share.revoked" as const })),
				...Arr.map(destinations, (row) => ({ row, action: "alert_destination.disabled" as const })),
			],
			({ row, action }) =>
				audit.record({
					orgId: row.orgId,
					actor: { type: "system" },
					source: "system",
					action,
					resourceId: row.id,
					affectedUserId: userId,
					metadata: { reason },
				}),
			{ discard: true },
		)

	/**
	 * Email destinations store a snapshot of resolved member addresses inside
	 * the encrypted secret config, so a removed member keeps receiving alerts
	 * until somebody re-saves the destination by hand. Rewrite both halves of
	 * the config with that member dropped.
	 *
	 * A destination left with zero members is disabled rather than deleted: the
	 * rules pointing at it stay valid, and an admin sees why it went quiet.
	 */
	const stripFromEmailDestinations = Effect.fn("MembershipRevocationService.stripFromEmailDestinations")(
		function* (orgId: OrgId | null, userId: UserId) {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(AlertDestinations)
						.select()
						.where(($) => [orgId === null ? undefined : $.orgId.eq(orgId), $.type.eq("email")]),
				),
			)
			const outcomes = yield* Effect.forEach(rows, (row) =>
				Effect.gen(function* () {
					const ref = { orgId: row.orgId, id: row.id }
					const secretJson = yield* openSecret(
						keyring,
						alertDestinationSecretSlot,
						ref,
						{ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag },
						() =>
							new MembershipRevocationError({
								message: `Could not decrypt alert destination ${row.id}`,
								...(orgId === null ? undefined : { orgId }),
							}),
					)
					const secret = decodeSecretConfig(secretJson)
					if (secret._tag === "None" || secret.value.type !== "email") return false
					const remaining = Arr.filter(secret.value.members, (member) => member.userId !== userId)
					if (remaining.length === secret.value.members.length) return false

					const nextSecret = { type: "email" as const, members: remaining }
					const nextSecretJson = yield* encodeSecretConfig(nextSecret).pipe(
						Effect.mapError(
							() =>
								new MembershipRevocationError({
									message: `Could not encode alert destination ${row.id}`,
									...(orgId === null ? undefined : { orgId }),
								}),
						),
					)
					const encrypted = yield* sealSecret(
						keyring,
						alertDestinationSecretSlot,
						ref,
						nextSecretJson,
						(message) =>
							new MembershipRevocationError({
								message,
								...(orgId === null ? undefined : { orgId }),
							}),
					)
					const publicConfig = decodePublicConfig(row.configJson)
					const first = remaining[0]
					const nextPublic = {
						...(publicConfig._tag === "Some" ? publicConfig.value : { channelLabel: null }),
						summary:
							first === undefined
								? "Email"
								: remaining.length === 1
									? (first.name ?? first.email)
									: `${first.name ?? first.email} +${remaining.length - 1} more`,
						channelLabel: first?.email ?? null,
						memberUserIds: Arr.map(remaining, (member) => member.userId),
					}
					const now = yield* Clock.currentTimeMillis
					yield* dbExecute((db) =>
						db.run(
							PG.update(AlertDestinations)
								.set({
									configJson: nextPublic,
									secretCiphertext: encrypted.ciphertext,
									secretIv: encrypted.iv,
									secretTag: encrypted.tag,
									updatedAt: now,
									...(remaining.length === 0
										? {
												enabled: false,
												disabledAt: now,
												disabledReason: "Last recipient left the organization",
											}
										: undefined),
								})
								.where(($) => [$.id.eq(row.id)]),
						),
					)
					return true
				}),
			)
			return Arr.filter(outcomes, Boolean).length
		},
	)

	const sweep = Effect.fnUntraced(function* (orgId: OrgId | null, userId: UserId) {
		yield* Effect.annotateCurrentSpan({
			...(orgId === null ? undefined : { orgId }),
			"tenant.userId": userId,
		})
		// First and unconditionally: it never fails, and until it runs the
		// `x-maple-org-id` header still selects this org for up to five minutes.
		yield* invalidateMembership(userId)

		const now = yield* Clock.currentTimeMillis

		// One transaction for the credential tables: a partial purge here is the
		// exact half-revoked state the whole fix exists to prevent.
		const credentials = yield* dbExecute((db) =>
			db.transaction(
				Effect.gen(function* () {
					const mcpFamiliesRevoked = yield* revokeRefreshFamiliesForMember(db, orgId, userId, now)
					// After the families, so an MCP access key retired above is already
					// `revoked` and is simply not claimed twice.
					const revokedKeys = yield* db.run(
						PG.update(ApiKeys)
							.set({ revoked: true, revokedAt: now })
							.where(($) => [
								orgId === null ? undefined : $.orgId.eq(orgId),
								$.createdBy.eq(userId),
								$.revoked.eq(false),
							])
							.returning("id"),
					)
					// Device-bound (DPoP) widget keys: every token issued for one re-reads it, so
					// revoking the row ends the device's access on its next request.
					const revokedDeviceCredentials = yield* db.run(
						PG.update(DeviceCredentials)
							.set({ revokedAt: now })
							.where(($) => [
								orgId === null ? undefined : $.orgId.eq(orgId),
								$.userId.eq(userId),
								$.revokedAt.isNull(),
							])
							.returning("id"),
					)
					const cliDeleted = yield* db.run(
						PG.deleteFrom(CliDeviceAuthorizations)
							.where(($) => [
								orgId === null ? undefined : $.approvedOrgId.eq(orgId),
								$.approvedUserId.eq(userId),
							])
							.returning("deviceCodeHash"),
					)
					const mcpAuthDeleted = yield* db.run(
						PG.deleteFrom(McpOAuthAuthorizations)
							.where(($) => [
								orgId === null ? undefined : $.approvedOrgId.eq(orgId),
								$.approvedUserId.eq(userId),
							])
							.returning("requestIdHash"),
					)
					const mobileDevicesDeleted = yield* deleteMobileDevices(db, orgId, userId)
					// A chat identity is standing authority to approve a change AS this user: the bot
					// reads the row on every button click and runs the tool under whatever roles the
					// user holds. Membership ending has to end that too, or the next click from their
					// chat account still acts for a member who is gone.
					const identitiesDeleted = yield* db.run(
						PG.deleteFrom(ChatIdentities)
							.where(($) => [
								orgId === null ? undefined : $.orgId.eq(orgId),
								$.userId.eq(userId),
							])
							.returning("id"),
					)
					// A member who rejoins is re-enabled by the daily reconcile.
					const digestsDisabled = yield* disableDigests(db, orgId, userId, now)
					const sharesRevoked = yield* revokeShares(db, orgId, userId, now)
					const destinationsDisabled = yield* disableDestinations(
						db,
						orgId,
						userId,
						now,
						"Creator left the organization",
					)
					return {
						sharesRevoked,
						destinationsDisabled,
						apiKeysRevoked: revokedKeys.length,
						mcpFamiliesRevoked,
						deviceCredentialsRevoked: revokedDeviceCredentials.length,
						cliAuthorizationsDeleted: cliDeleted.length,
						mcpAuthorizationsDeleted: mcpAuthDeleted.length,
						mobileDevicesDeleted,
						chatIdentitiesDeleted: identitiesDeleted.length,
						digestSubscriptionsDisabled: digestsDisabled.length,
					}
				}),
			),
		)

		const emailDestinationsUpdated = yield* stripFromEmailDestinations(orgId, userId)

		// After the commit: a retry finds these rows already retired, so nothing is recorded twice.
		const { sharesRevoked, destinationsDisabled, ...counts } = credentials
		yield* recordRetired(userId, sharesRevoked, destinationsDisabled, "membership_ended")

		const summary = {
			...counts,
			dashboardSharesRevoked: sharesRevoked.length,
			alertDestinationsDisabled: destinationsDisabled.length,
			emailDestinationsUpdated,
		} satisfies MembershipRevocationSummary
		yield* Effect.annotateCurrentSpan({
			"maple.membership.api_keys_revoked": summary.apiKeysRevoked,
			"maple.membership.mcp_families_revoked": summary.mcpFamiliesRevoked,
			"maple.membership.device_credentials_revoked": summary.deviceCredentialsRevoked,
			"maple.membership.cli_authorizations_deleted": summary.cliAuthorizationsDeleted,
			"maple.membership.mcp_authorizations_deleted": summary.mcpAuthorizationsDeleted,
			"maple.membership.email_destinations_updated": summary.emailDestinationsUpdated,
			"maple.membership.mobile_devices_deleted": summary.mobileDevicesDeleted,
			"maple.membership.chat_identities_deleted": summary.chatIdentitiesDeleted,
			"maple.membership.digest_subscriptions_disabled": summary.digestSubscriptionsDisabled,
			"maple.membership.dashboard_shares_revoked": summary.dashboardSharesRevoked,
			"maple.membership.alert_destinations_disabled": summary.alertDestinationsDisabled,
		})
		return summary
	})

	/**
	 * Demotion, the security-relevant direction of a role change. CLI, MCP and
	 * device keys pin the minting user's roles into `metadata_json` and
	 * `resolveByKey` reads them back without ever re-checking the membership, so
	 * an admin who ran `maple auth login` and was then demoted keeps admin on
	 * that key until it expires. Any credential pinned to a permission the member no
	 * longer holds is retired here; MCP families go with their access key, or the
	 * next hourly rotation would mint the authority straight back.
	 *
	 * Known residue: a plain `standard` key carries no pinned roles and resolves
	 * with the `root` default, so a demoted admin's ordinary API keys keep full
	 * authority. Revoking those on demotion would silently break org automation
	 * an admin created for the org rather than for themselves, so it is left:
	 * deliberately, and stated rather than implied.
	 */
	const demoteMembership = Effect.fn("MembershipRevocationService.demoteMembership")(function* (
		orgId: OrgId,
		userId: UserId,
		current: Policy.Grants,
	) {
		yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
		yield* invalidateMembership(userId)
		// Anything pinned to a permission the member no longer holds is retired.
		const outlivesDemotion = (
			roles: ReadonlyArray<string> | null,
			codes: ReadonlyArray<number> | null | undefined,
		) => roles !== null && Policy.exceeds(pinnedGrants(roles, codes ?? undefined), current)
		if (!Policy.exceeds(Policy.allPermissions, current)) {
			return {
				apiKeysRevoked: 0,
				mcpFamiliesRevoked: 0,
				deviceCredentialsRevoked: 0,
				dashboardSharesRevoked: 0,
				digestSubscriptionsDisabled: 0,
				mobileDevicesDeleted: 0,
			} satisfies MembershipDemotionSummary
		}
		const readsTelemetry = Policy.can(current, "telemetry:read")

		const now = yield* Clock.currentTimeMillis
		const { sharesRevoked, ...summary } = yield* dbExecute((db) =>
			db.transaction(
				Effect.gen(function* () {
					// What carries telemetry to the member that the new role could not: a public link, the
					// digest and phone pushes. Alert destinations are the org's routing, so a demotion leaves
					// them alone.
					const sharesRevoked =
						readsTelemetry && Policy.can(current, "dashboards:share")
							? []
							: yield* revokeShares(db, orgId, userId, now)
					const digestSubscriptionsDisabled = readsTelemetry
						? 0
						: (yield* disableDigests(db, orgId, userId, now)).length
					const mobileDevicesDeleted = readsTelemetry
						? 0
						: yield* deleteMobileDevices(db, orgId, userId)
					const retired = { sharesRevoked, digestSubscriptionsDisabled, mobileDevicesDeleted }
					// An approval not yet redeemed froze the old role and would mint a credential at it.
					const cliApprovals = yield* db.run(
						PG.from(CliDeviceAuthorizations)
							.select("deviceCodeHash", "approvedRoles", "approvedPermissions")
							.where(($) => [$.approvedOrgId.eq(orgId), $.approvedUserId.eq(userId)]),
					)
					const [firstCli, ...restCli] = Arr.map(
						Arr.filter(cliApprovals, (row) =>
							outlivesDemotion(row.approvedRoles, row.approvedPermissions),
						),
						(row) => row.deviceCodeHash,
					)
					if (firstCli !== undefined) {
						yield* db.run(
							PG.deleteFrom(CliDeviceAuthorizations).where(($) => [
								$.deviceCodeHash.in_(firstCli, ...restCli),
							]),
						)
					}
					const mcpApprovals = yield* db.run(
						PG.from(McpOAuthAuthorizations)
							.select("requestIdHash", "approvedRoles", "approvedPermissions")
							.where(($) => [$.approvedOrgId.eq(orgId), $.approvedUserId.eq(userId)]),
					)
					const [firstMcp, ...restMcp] = Arr.map(
						Arr.filter(mcpApprovals, (row) =>
							outlivesDemotion(row.approvedRoles, row.approvedPermissions),
						),
						(row) => row.requestIdHash,
					)
					if (firstMcp !== undefined) {
						yield* db.run(
							PG.deleteFrom(McpOAuthAuthorizations).where(($) => [
								$.requestIdHash.in_(firstMcp, ...restMcp),
							]),
						)
					}
					// Device credentials pin roles in a column rather than key metadata.
					const liveDevices = yield* db.run(
						PG.from(DeviceCredentials)
							.select("id", "roles", "permissions")
							.where(($) => [$.orgId.eq(orgId), $.userId.eq(userId), $.revokedAt.isNull()]),
					)
					const [firstDevice, ...restDevices] = Arr.map(
						Arr.filter(liveDevices, (row) => outlivesDemotion(row.roles, row.permissions)),
						(row) => row.id,
					)
					const deviceCredentialsRevoked =
						firstDevice === undefined
							? 0
							: (yield* db.run(
									PG.update(DeviceCredentials)
										.set({ revokedAt: now })
										.where(($) => [
											$.id.in_(firstDevice, ...restDevices),
											$.revokedAt.isNull(),
										])
										.returning("id"),
								)).length
					const live = yield* db.run(
						PG.from(ApiKeys)
							.select("id", "metadataJson", "scopes")
							.where(($) => [$.orgId.eq(orgId), $.createdBy.eq(userId), $.revoked.eq(false)]),
					)
					const outlived = Arr.filterMap(live, (row) => {
						const pinned = decodePinnedRoles(row.metadataJson)
						return pinned._tag === "Some" &&
							Predicate.isObject(row.metadataJson) &&
							outlivesDemotion(pinned.value.roles, pinned.value.permissions)
							? Result.succeed({
									id: row.id,
									scopes: row.scopes,
									metadata: row.metadataJson,
									pinned: pinned.value,
								})
							: Result.failVoid
					})
					// A restricted key whose scopes the member could still grant keeps working: its pin
					// narrows to what they hold now, the way a custom role pins permission codes.
					const [narrowed, staleKeys] = Arr.partition(outlived, (key) =>
						Policy.canGrantScopes((permission) => Policy.can(current, permission), key.scopes)
							? Result.succeed(key)
							: Result.fail(key.id),
					)
					yield* Effect.forEach(
						narrowed,
						({ id, metadata, pinned }) => {
							const held = Arr.filter(
								pinnedGrants(pinned.roles, pinned.permissions),
								(permission) => Policy.can(current, permission),
							)
							return db.run(
								PG.update(ApiKeys)
									.set({
										metadataJson: {
											...metadata,
											roles: [Policy.CUSTOM_ROLE_CLERK_KEY],
											permissions: Policy.encodePermissions(held),
										},
									})
									.where(($) => [$.id.eq(id), $.revoked.eq(false)]),
							)
						},
						{ discard: true },
					)
					const stale = staleKeys
					const [first, ...rest] = stale
					if (first === undefined)
						return {
							...retired,
							apiKeysRevoked: 0,
							mcpFamiliesRevoked: 0,
							deviceCredentialsRevoked,
						}

					const revoked = yield* db.run(
						PG.update(ApiKeys)
							.set({ revoked: true, revokedAt: now })
							.where(($) => [$.id.in_(first, ...rest), $.revoked.eq(false)])
							.returning("id"),
					)
					const mcpFamiliesRevoked = yield* revokeFamiliesForAccessKeys(db, stale, now)
					return {
						...retired,
						apiKeysRevoked: revoked.length,
						mcpFamiliesRevoked,
						deviceCredentialsRevoked,
					}
				}),
			),
		)
		yield* recordRetired(userId, sharesRevoked, [], "role_changed")

		const demoted = {
			...summary,
			dashboardSharesRevoked: sharesRevoked.length,
		} satisfies MembershipDemotionSummary
		yield* Effect.annotateCurrentSpan({
			"maple.membership.demoted_api_keys_revoked": demoted.apiKeysRevoked,
			"maple.membership.demoted_mcp_families_revoked": demoted.mcpFamiliesRevoked,
			"maple.membership.demoted_device_credentials_revoked": demoted.deviceCredentialsRevoked,
			"maple.membership.demoted_dashboard_shares_revoked": demoted.dashboardSharesRevoked,
			"maple.membership.demoted_digest_subscriptions_disabled": demoted.digestSubscriptionsDisabled,
			"maple.membership.demoted_mobile_devices_deleted": demoted.mobileDevicesDeleted,
		})
		return demoted
	})

	const revokeMembership = Effect.fn("MembershipRevocationService.revokeMembership")(
		(orgId: OrgId, userId: UserId) => sweep(orgId, userId),
	)
	const revokeUser = Effect.fn("MembershipRevocationService.revokeUser")((userId: UserId) =>
		sweep(null, userId),
	)

	return {
		revokeMembership,
		revokeUser,
		demoteMembership,
		invalidateMembership,
	} satisfies MembershipRevocationServiceApi
})

export class MembershipRevocationService extends Context.Service<
	MembershipRevocationService,
	MembershipRevocationServiceApi
>()("@maple/backend/services/auth/MembershipRevocationService", { make }) {
	static readonly layer = Layer.effect(this, this.make)
}
