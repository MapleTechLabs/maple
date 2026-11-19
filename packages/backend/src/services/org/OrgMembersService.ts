import * as Clerk from "@distilled.cloud/clerk"
import {
	AlertMemberDirectoryNotConfiguredError,
	AlertMemberDirectoryUnavailableError,
	AlertRecipientSelectionError,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { Array as Arr, Context, Effect, Layer, Option, Stream } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { type ClerkApi, clerkModeApi } from "@maple/auth"

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
	/**
	 * Resolve workspace-member user ids to their emails via the auth provider.
	 * Fails when any id is not a member of the org, or when member resolution
	 * is unavailable (self-hosted mode without Clerk).
	 */
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

	const clerk = clerkModeApi(env) ?? null

	const notConfigured = new AlertMemberDirectoryNotConfiguredError({
		message: "Workspace member lookup requires Clerk authentication",
	})

	/** Every membership of the org, one Clerk call per 100. */
	const listMemberships = (clerk: ClerkApi, orgId: OrgId) => {
		const PAGE_SIZE = 100
		return Stream.paginate(0, (offset: number) =>
			clerk
				.run(Clerk.listOrganizationMemberships({ organization_id: orgId, limit: PAGE_SIZE, offset }))
				.pipe(
					Effect.mapBoth({
						onFailure: (cause) =>
							new AlertMemberDirectoryUnavailableError({
								message: `Failed to list workspace members for ${orgId}`,
								cause,
							}),
						onSuccess: (page) => {
							const next = offset + page.data.length
							const done = next >= page.total_count || page.data.length === 0
							return [page.data, done ? Option.none<number>() : Option.some(next)] as const
						},
					}),
				),
		).pipe(Stream.runCollect)
	}

	const memberName = (member: Clerk.OrganizationMembership): string | null =>
		Arr.join(
			Arr.filter(
				[member.public_user_data?.first_name, member.public_user_data?.last_name],
				(part): part is string => typeof part === "string" && part !== "",
			),
			" ",
		) || null

	const listMembers = Effect.fn("OrgMembersService.listMembers")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan("orgId", orgId)
		if (clerk === null) return yield* notConfigured
		const memberships = yield* listMemberships(clerk, orgId)
		return Arr.flatMap(memberships, (member): Array<OrgMember> => {
			const userId = member.public_user_data?.user_id
			const email = member.public_user_data?.identifier
			if (!userId || !email) return []
			return [
				{
					userId,
					email,
					name: memberName(member),
					imageUrl: member.public_user_data?.image_url ?? null,
				},
			]
		})
	})

	const listMemberActivity = Effect.fn("OrgMembersService.listMemberActivity")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan("orgId", orgId)
		if (clerk === null) return yield* notConfigured
		const memberships = yield* listMemberships(clerk, orgId)
		const userIds = Arr.flatMap(memberships, (member) =>
			Option.toArray(Option.fromNullishOr(member.public_user_data?.user_id)),
		)
		// Clerk filters by at most 100 user ids per call.
		const users = yield* Effect.forEach(
			Arr.chunksOf(userIds, 100),
			(chunk) =>
				clerk.run(Clerk.getUserList({ user_id: [...chunk], limit: chunk.length })).pipe(
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
		const byId = new Map(Arr.map(Arr.flatten(users), (user) => [user.id, user] as const))
		return Arr.map(memberships, (member): MemberActivity => {
			const user = byId.get(member.public_user_data?.user_id ?? "")
			return {
				name: memberName(member),
				role: member.role,
				joinedAtMs: member.created_at,
				lastSignInAtMs: user?.last_sign_in_at ?? null,
				lastActiveAtMs: user?.last_active_at ?? null,
			}
		})
	})

	const listOrganizationsOf = Effect.fn("OrgMembersService.listOrganizationsOf")(function* (
		userId: string,
	) {
		if (clerk === null) {
			return yield* new AlertMemberDirectoryNotConfiguredError({
				message: "Organization lookup requires Clerk authentication",
			})
		}
		const page = yield* clerk
			.run(Clerk.usersGetOrganizationMemberships({ user_id: userId, limit: 100 }))
			.pipe(
				Effect.mapError(
					(cause) =>
						new AlertMemberDirectoryUnavailableError({
							message: `Failed to list the organizations of ${userId}`,
							cause,
						}),
				),
			)
		return Arr.map(page.data, (membership): UserOrganization => ({
			orgId: membership.organization.id,
			name: membership.organization.name,
			createdAtMs: membership.organization.created_at,
			membersCount: membership.organization.members_count ?? null,
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
		const byUserId = new Map(Arr.map(members, (member) => [member.userId, member] as const))
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
			return yield* new AlertRecipientSelectionError({
				message: "Some selected users are not members of this workspace",
				unknownUserIds: unknown,
			})
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
	"@maple/backend/services/OrgMembersService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
