import { type ClerkClient, createClerkClient, type OrganizationMembership } from "@clerk/backend"
import {
	AlertMemberDirectoryNotConfiguredError,
	AlertMemberDirectoryUnavailableError,
	AlertRecipientSelectionError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { Array as Arr, Context, Effect, Layer, Option, Redacted, Stream } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { clerkRequest } from "@maple/backend/services/auth/clerk-request"

export interface OrgMember {
	readonly userId: string
	readonly email: string
	readonly name: string | null
	/** Provider-hosted avatar; Clerk serves one for every user, initials included. */
	readonly imageUrl: string | null
}

/** One membership's role and timestamps. */
export interface MemberActivity {
	/** First and last name; only for telling a person's name from a company's. */
	readonly name: string | null
	readonly role: string
	readonly joinedAtMs: number
	/** Null when the user never signed in, or Clerk no longer has the user. */
	readonly lastSignInAtMs: number | null
	readonly lastActiveAtMs: number | null
}

export interface UserOrganization {
	readonly orgId: string
	readonly name: string
	readonly createdAtMs: number
	readonly membersCount: number | null
}

export interface OrgMembersServiceApi {
	/**
	 * Resolve workspace-member user ids to their emails via the auth provider.
	 * Fails when any id is not a member of the org, or when member resolution
	 * is unavailable (self-hosted mode without Clerk).
	 */
	/**
	 * Every member of the org. Unlike {@link resolveMembers} this answers for
	 * the directory as it is now, so a caller labelling historical records gets
	 * the members it can name and nothing for ids that have since left.
	 */
	readonly listMembers: (
		orgId: OrgId,
	) => Effect.Effect<
		ReadonlyArray<OrgMember>,
		AlertMemberDirectoryNotConfiguredError | AlertMemberDirectoryUnavailableError
	>
	/** The orgs a user belongs to; the first 100, which is every real account. */
	readonly listOrganizationsOf: (
		userId: string,
	) => Effect.Effect<
		ReadonlyArray<UserOrganization>,
		AlertMemberDirectoryNotConfiguredError | AlertMemberDirectoryUnavailableError
	>
	/** Every membership of the org with its role, join time and the user's last sign-in and activity. */
	readonly listMemberActivity: (
		orgId: OrgId,
	) => Effect.Effect<
		ReadonlyArray<MemberActivity>,
		AlertMemberDirectoryNotConfiguredError | AlertMemberDirectoryUnavailableError
	>
	readonly resolveMembers: (
		orgId: OrgId,
		userIds: ReadonlyArray<UserId>,
	) => Effect.Effect<
		ReadonlyArray<OrgMember>,
		| AlertMemberDirectoryNotConfiguredError
		| AlertMemberDirectoryUnavailableError
		| AlertRecipientSelectionError
	>
}

const make = Effect.gen(function* () {
	const env = yield* Env

	const clerk =
		env.MAPLE_AUTH_MODE.toLowerCase() === "clerk" && Option.isSome(env.CLERK_SECRET_KEY)
			? createClerkClient({ secretKey: Redacted.value(env.CLERK_SECRET_KEY.value) })
			: null

	const notConfigured = new AlertMemberDirectoryNotConfiguredError({
		message: "Workspace member lookup requires Clerk authentication",
	})

	/** Every membership of the org, one Clerk call per 100. */
	const listMemberships = (clerk: ClerkClient, orgId: OrgId) => {
		const PAGE_SIZE = 100
		return Stream.paginate(0, (offset: number) =>
			clerkRequest("Clerk.organizations.getOrganizationMembershipList", { orgId }, () =>
				clerk.organizations.getOrganizationMembershipList({
					organizationId: orgId,
					limit: PAGE_SIZE,
					offset,
				}),
			).pipe(
				Effect.mapError(
					(cause) =>
						new AlertMemberDirectoryUnavailableError({
							message: `Failed to list workspace members for ${orgId}`,
							cause,
						}),
				),
				Effect.map((page) => {
					const next = offset + page.data.length
					const done = next >= page.totalCount || page.data.length === 0
					return [page.data, done ? Option.none<number>() : Option.some(next)] as const
				}),
			),
		).pipe(Stream.runCollect)
	}

	const memberName = (member: OrganizationMembership): string | null =>
		[member.publicUserData?.firstName, member.publicUserData?.lastName].filter(Boolean).join(" ") || null

	const listMembers = Effect.fn("OrgMembersService.listMembers")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan("orgId", orgId)
		if (clerk === null) return yield* Effect.fail(notConfigured)
		const memberships = yield* listMemberships(clerk, orgId)
		return memberships.flatMap((member): Array<OrgMember> => {
			const userId = member.publicUserData?.userId
			const email = member.publicUserData?.identifier
			if (!userId || !email) return []
			return [
				{
					userId,
					email,
					name: memberName(member),
					imageUrl: member.publicUserData?.imageUrl ?? null,
				},
			]
		})
	})

	const listMemberActivity = Effect.fn("OrgMembersService.listMemberActivity")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan("orgId", orgId)
		if (clerk === null) return yield* Effect.fail(notConfigured)
		const memberships = yield* listMemberships(clerk, orgId)
		const userIds = memberships.flatMap((member) => member.publicUserData?.userId ?? [])
		// Clerk filters by at most 100 user ids per call.
		const users = yield* Effect.forEach(
			Arr.chunksOf(userIds, 100),
			(chunk) =>
				clerkRequest(
					"Clerk.users.getUserList",
					{ "maple.organization.member.requested_count": chunk.length },
					() => clerk.users.getUserList({ userId: [...chunk], limit: chunk.length }),
				).pipe(
					Effect.mapError(
						(cause) =>
							new AlertMemberDirectoryUnavailableError({
								message: `Failed to read the members of ${orgId}`,
								cause,
							}),
					),
				),
			{ concurrency: 2 },
		)
		const byId = new Map(users.flatMap((page) => page.data).map((user) => [user.id, user]))
		return memberships.map((member): MemberActivity => {
			const user = byId.get(member.publicUserData?.userId ?? "")
			return {
				name: memberName(member),
				role: member.role,
				joinedAtMs: member.createdAt,
				lastSignInAtMs: user?.lastSignInAt ?? null,
				lastActiveAtMs: user?.lastActiveAt ?? null,
			}
		})
	})

	const listOrganizationsOf = Effect.fn("OrgMembersService.listOrganizationsOf")(function* (
		userId: string,
	) {
		if (clerk === null) {
			return yield* Effect.fail(
				new AlertMemberDirectoryNotConfiguredError({
					message: "Organization lookup requires Clerk authentication",
				}),
			)
		}
		const page = yield* clerkRequest(
			"Clerk.users.getOrganizationMembershipList",
			{ "tenant.userId": userId },
			() => clerk.users.getOrganizationMembershipList({ userId, limit: 100 }),
		).pipe(
			Effect.mapError(
				(cause) =>
					new AlertMemberDirectoryUnavailableError({
						message: `Failed to list the organizations of ${userId}`,
						cause,
					}),
			),
		)
		return page.data.map((membership): UserOrganization => ({
			orgId: membership.organization.id,
			name: membership.organization.name,
			createdAtMs: membership.organization.createdAt,
			membersCount: membership.organization.membersCount ?? null,
		}))
	})

	const resolveMembers: OrgMembersServiceApi["resolveMembers"] = Effect.fn(
		"OrgMembersService.resolveMembers",
	)(function* (orgId: OrgId, userIds: ReadonlyArray<UserId>) {
		yield* Effect.annotateCurrentSpan({
			orgId,
			"maple.organization.member.requested_count": userIds.length,
		})
		const members = yield* listMembers(orgId)
		const byUserId = new Map(members.map((member) => [member.userId, member]))
		const resolved: Array<OrgMember> = []
		const unknown: Array<UserId> = []
		const seen = new Set<string>()
		for (const userId of userIds) {
			if (seen.has(userId)) continue
			seen.add(userId)
			const member = byUserId.get(userId)
			if (member === undefined) unknown.push(userId)
			else resolved.push(member)
		}
		if (unknown.length > 0) {
			return yield* Effect.fail(
				new AlertRecipientSelectionError({
					message: "Some selected users are not members of this workspace",
					unknownUserIds: unknown,
				}),
			)
		}
		yield* Effect.annotateCurrentSpan("result.member_count", resolved.length)
		return resolved
	})

	return {
		listMembers,
		listMemberActivity,
		listOrganizationsOf,
		resolveMembers,
	} satisfies OrgMembersServiceApi
})

export class OrgMembersService extends Context.Service<OrgMembersService, OrgMembersServiceApi>()(
	"@maple/api/services/OrgMembersService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
