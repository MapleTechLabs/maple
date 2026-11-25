import * as Clerk from "@distilled.cloud/clerk"
import { type ClerkApiServices, type ClerkRequestError, clerkModeApi } from "@maple/auth"
import { type OrgId, RolesUnavailableError, UserId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { Env } from "@maple/backend/platform/Env"

// Every Clerk call the roles endpoints make: the definitions in the organization's public metadata,
// and the memberships that hold them. Self-hosted mode has no Clerk, so every call fails.

/** One membership of the organization, as the roles endpoints read it. */
export interface RoleMembership {
	readonly userId: UserId
	/** The Clerk role key: a built-in role, or `org:custom`. */
	readonly role: string
	/** The membership's public metadata, where an `org:custom` member's role lives. */
	readonly metadata: unknown
	readonly name: string | null
	/** Email or username. */
	readonly identifier: string
	readonly imageUrl: string | null
}

export interface ClerkRolesGatewayApi {
	/** The custom role definitions in the organization's public metadata; unavailable when they do not decode. */
	readonly customRoles: (orgId: OrgId) => Effect.Effect<Policy.VersionedCustomRoles, RolesUnavailableError>
	/** Replace the organization's custom role definitions; other metadata keys stay. */
	readonly writeCustomRoles: (
		orgId: OrgId,
		stored: Policy.VersionedCustomRoles,
	) => Effect.Effect<void, RolesUnavailableError>
	/** Every membership of the organization, one Clerk call per 100. */
	readonly memberships: (
		orgId: OrgId,
	) => Effect.Effect<ReadonlyArray<RoleMembership>, RolesUnavailableError>
	readonly setMembershipRole: (
		orgId: OrgId,
		userId: UserId,
		role: Policy.AssignableClerkRole,
	) => Effect.Effect<void, RolesUnavailableError>
	/** Write the membership's custom role, or remove it with `null`. */
	readonly setMembershipCustomRole: (
		orgId: OrgId,
		userId: UserId,
		role: Policy.MembershipRoleMetadata | null,
	) => Effect.Effect<void, RolesUnavailableError>
}

const MEMBERSHIP_PAGE_SIZE = 100

const decodeUserId = Schema.decodeUnknownOption(UserId)

const unavailable = (error: ClerkRequestError) =>
	new RolesUnavailableError({ message: `Clerk request failed: ${error.message}`, cause: error })

const memberName = (member: Clerk.OrganizationMembership): string | null =>
	Arr.join(
		Arr.filter(
			[member.public_user_data?.first_name, member.public_user_data?.last_name],
			(part): part is string => typeof part === "string" && part !== "",
		),
		" ",
	) || null

const toRoleMembership = (member: Clerk.OrganizationMembership): Option.Option<RoleMembership> =>
	Option.map(decodeUserId(member.public_user_data?.user_id), (userId) => ({
		userId,
		role: member.role,
		metadata: member.public_metadata,
		name: memberName(member),
		identifier: member.public_user_data?.identifier ?? "",
		imageUrl: member.public_user_data?.image_url ?? null,
	}))

const make = Effect.gen(function* () {
	const env = yield* Env
	const clerk = clerkModeApi(env)

	const withClerk = <A, E>(
		operation: Effect.Effect<A, E, ClerkApiServices>,
	): Effect.Effect<A, RolesUnavailableError> =>
		clerk === undefined
			? Effect.fail(new RolesUnavailableError({ message: "Roles need Clerk" }))
			: clerk.run(operation).pipe(Effect.mapError(unavailable))

	const customRoles: ClerkRolesGatewayApi["customRoles"] = (orgId) =>
		withClerk(Clerk.getOrganization({ organization_id: orgId })).pipe(
			Effect.flatMap((organization) =>
				Effect.fromOption(
					Policy.versionedCustomRolesFromOrgMetadata(organization.public_metadata),
					() =>
						new RolesUnavailableError({
							message: "The organization's custom roles could not be read",
						}),
				),
			),
		)

	// Clerk merges public metadata by key, so the region and rollout flags stay as they are. It has
	// no conditional write: RolesService re-reads the version just before writing instead.
	const writeCustomRoles: ClerkRolesGatewayApi["writeCustomRoles"] = (orgId, stored) =>
		withClerk(
			Clerk.mergeOrganizationMetadata({
				organization_id: orgId,
				public_metadata: {
					[Policy.ORG_ROLES_METADATA_KEY]: stored satisfies Policy.StoredCustomRoles,
				},
			}),
		).pipe(Effect.asVoid)

	const memberships: ClerkRolesGatewayApi["memberships"] = (orgId) =>
		Stream.paginate(0, (offset: number) =>
			withClerk(
				Clerk.listOrganizationMemberships({
					organization_id: orgId,
					limit: MEMBERSHIP_PAGE_SIZE,
					offset,
				}),
			).pipe(
				Effect.map((page) => {
					const next = offset + page.data.length
					const done = next >= page.total_count || page.data.length === 0
					return [page.data, done ? Option.none<number>() : Option.some(next)] as const
				}),
			),
		).pipe(
			Stream.runCollect,
			Effect.map((members) => Arr.getSomes(Arr.map(members, toRoleMembership))),
		)

	const setMembershipRole: ClerkRolesGatewayApi["setMembershipRole"] = (orgId, userId, role) =>
		withClerk(Clerk.updateOrganizationMembership({ organization_id: orgId, user_id: userId, role })).pipe(
			Effect.asVoid,
		)

	const setMembershipCustomRole: ClerkRolesGatewayApi["setMembershipCustomRole"] = (orgId, userId, role) =>
		withClerk(
			Clerk.updateOrganizationMembershipMetadata({
				organization_id: orgId,
				user_id: userId,
				public_metadata: { [Policy.MEMBERSHIP_ROLE_METADATA_KEY]: role },
			}),
		).pipe(Effect.asVoid)

	return {
		customRoles,
		writeCustomRoles,
		memberships,
		setMembershipRole,
		setMembershipCustomRole,
	} satisfies ClerkRolesGatewayApi
})

export class ClerkRolesGateway extends Context.Service<ClerkRolesGateway, ClerkRolesGatewayApi>()(
	"@maple/backend/services/roles/ClerkRolesGateway",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
