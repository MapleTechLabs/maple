import type { ClerkClient, OrganizationMembership } from "@clerk/backend"
import { clerkModeClient } from "@maple/auth"
import { type OrgId, RolesUnavailableError, UserId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { type ClerkRequestError, clerkRequest } from "@maple/backend/services/auth/clerk-request"

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
	/** One member's membership as Clerk holds it now; `None` once they left. */
	readonly membership: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<Option.Option<RoleMembership>, RolesUnavailableError>
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
	new RolesUnavailableError({ message: `Clerk request failed: ${error.operation}`, cause: error })

const memberName = (member: OrganizationMembership): string | null =>
	Arr.join(
		Arr.filter(
			[member.publicUserData?.firstName, member.publicUserData?.lastName],
			(part): part is string => typeof part === "string" && part !== "",
		),
		" ",
	) || null

const toRoleMembership = (member: OrganizationMembership): Option.Option<RoleMembership> =>
	Option.map(decodeUserId(member.publicUserData?.userId), (userId) => ({
		userId,
		role: member.role,
		metadata: member.publicMetadata,
		name: memberName(member),
		identifier: member.publicUserData?.identifier ?? "",
		imageUrl: member.publicUserData?.imageUrl ?? null,
	}))

const make = Effect.gen(function* () {
	const env = yield* Env
	const clerk = clerkModeClient(env)

	const withClerk = <A>(
		spanName: string,
		attributes: Readonly<Record<string, string>>,
		request: (clerk: ClerkClient) => Promise<A>,
	): Effect.Effect<A, RolesUnavailableError> =>
		clerk === undefined
			? Effect.fail(new RolesUnavailableError({ message: "Roles need Clerk" }))
			: clerkRequest(spanName, attributes, () => request(clerk)).pipe(Effect.mapError(unavailable))

	const customRoles: ClerkRolesGatewayApi["customRoles"] = (orgId) =>
		withClerk("Clerk.organizations.getOrganization", { orgId }, (client) =>
			client.organizations.getOrganization({ organizationId: orgId }),
		).pipe(
			Effect.flatMap((organization) =>
				Effect.fromOption(
					Policy.versionedCustomRolesFromOrgMetadata(organization.publicMetadata),
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
		withClerk("Clerk.organizations.updateOrganizationMetadata", { orgId }, (client) =>
			client.organizations.updateOrganizationMetadata(orgId, {
				publicMetadata: {
					[Policy.ORG_ROLES_METADATA_KEY]: stored satisfies Policy.StoredCustomRoles,
				},
			}),
		).pipe(Effect.asVoid)

	const memberships: ClerkRolesGatewayApi["memberships"] = (orgId) =>
		Stream.paginate(0, (offset: number) =>
			withClerk("Clerk.organizations.getOrganizationMembershipList", { orgId }, (client) =>
				client.organizations.getOrganizationMembershipList({
					organizationId: orgId,
					limit: MEMBERSHIP_PAGE_SIZE,
					offset,
				}),
			).pipe(
				Effect.map((page) => {
					const next = offset + page.data.length
					const done = next >= page.totalCount || page.data.length === 0
					return [page.data, done ? Option.none<number>() : Option.some(next)] as const
				}),
			),
		).pipe(
			Stream.runCollect,
			Effect.map((members) => Arr.getSomes(Arr.map(members, toRoleMembership))),
		)

	const membership: ClerkRolesGatewayApi["membership"] = (orgId, userId) =>
		withClerk(
			"Clerk.organizations.getOrganizationMembershipList",
			{ orgId, "tenant.userId": userId },
			(client) =>
				client.organizations.getOrganizationMembershipList({
					organizationId: orgId,
					userId: [userId],
					limit: 1,
				}),
		).pipe(Effect.map((page) => Option.flatMap(Arr.head(page.data), toRoleMembership)))

	const setMembershipRole: ClerkRolesGatewayApi["setMembershipRole"] = (orgId, userId, role) =>
		withClerk(
			"Clerk.organizations.updateOrganizationMembership",
			{ orgId, "tenant.userId": userId },
			(client) =>
				client.organizations.updateOrganizationMembership({ organizationId: orgId, userId, role }),
		).pipe(Effect.asVoid)

	const setMembershipCustomRole: ClerkRolesGatewayApi["setMembershipCustomRole"] = (orgId, userId, role) =>
		withClerk(
			"Clerk.organizations.updateOrganizationMembershipMetadata",
			{ orgId, "tenant.userId": userId },
			(client) =>
				client.organizations.updateOrganizationMembershipMetadata({
					organizationId: orgId,
					userId,
					publicMetadata: { [Policy.MEMBERSHIP_ROLE_METADATA_KEY]: role },
				}),
		).pipe(Effect.asVoid)

	return {
		customRoles,
		writeCustomRoles,
		memberships,
		membership,
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
