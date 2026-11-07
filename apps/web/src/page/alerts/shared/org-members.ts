import { UserId } from "@maple/domain/http"
import { Array as Arr, Effect, Option, Schema } from "effect"
import {
	type ClerkMembershipResource,
	type ClerkOrganizationResource,
	clerkTry,
	currentClerkOrganization,
} from "../../../platform/clerk"

// The org's members as the on-call pickers and names read them: Clerk's memberships, every page
// up to `MAX_MEMBERS` (an org past that names the rest "Member" and cannot pick them here).

const PAGE_SIZE = 100
export const MAX_MEMBERS = 2000

export const OrgMember = Schema.Struct({
	userId: UserId,
	name: Schema.String,
	email: Schema.String,
	/** `""` without an uploaded image: the warm initials tile stands in. */
	imageUrl: Schema.String,
})
export type OrgMember = typeof OrgMember.Type

const decodeUserIdOption = Schema.decodeUnknownOption(UserId)

const memberOfMembership = (member: ClerkMembershipResource): ReadonlyArray<OrgMember> => {
	const user = member.publicUserData
	const email = user?.identifier ?? ""
	const name = Arr.join(
		Arr.filter([user?.firstName, user?.lastName], (part): part is string => Boolean(part)),
		" ",
	)
	return Option.match(decodeUserIdOption(user?.userId), {
		onNone: () => [],
		onSome: (userId) => [
			{
				userId,
				name: name || email || "Unknown member",
				email,
				imageUrl: user?.hasImage === true ? user.imageUrl : "",
			},
		],
	})
}

/** Every member of `organization` with a user id, named by first and last name, else by email. */
export const membersOf = (
	organization: Pick<ClerkOrganizationResource, "getMemberships">,
): Effect.Effect<ReadonlyArray<OrgMember>, string> =>
	Effect.gen(function* () {
		const page = (initialPage: number) =>
			clerkTry("Couldn't load members", () =>
				organization.getMemberships({ initialPage, pageSize: PAGE_SIZE }),
			)
		const first = yield* page(1)
		const pageCount = Math.ceil(Math.min(first.total_count, MAX_MEMBERS) / PAGE_SIZE)
		// The rest of the pages, 4 at a time.
		const rest = yield* Effect.forEach(pageCount > 1 ? Arr.range(2, pageCount) : [], page, {
			concurrency: 4,
		})
		return Arr.flatMap([first, ...rest], (result) => Arr.flatMap(result.data, memberOfMembership))
	}).pipe(Effect.mapError((error) => error.message))

/** The current org's members. */
export const listOrgMembers: Effect.Effect<ReadonlyArray<OrgMember>, string> = currentClerkOrganization.pipe(
	Effect.mapError((error) => error.message),
	Effect.flatMap(membersOf),
)

/**
 * A member by id; someone who left the org reads as "A former member". Until the members load, after
 * a failed read, or in an org past `MAX_MEMBERS`, an unknown id reads neutrally as "Member".
 */
export const memberName = (members: ReadonlyArray<OrgMember> | null, userId: string): string =>
	members === null || members.length >= MAX_MEMBERS
		? Option.getOrElse(
				Option.map(
					Arr.findFirst(members ?? [], (member) => member.userId === userId),
					(member) => member.name,
				),
				() => "Member",
			)
		: Option.getOrElse(
				Option.map(
					Arr.findFirst(members, (member) => member.userId === userId),
					(member) => member.name,
				),
				() => "A former member",
			)

export const memberOf = (
	members: ReadonlyArray<OrgMember> | null,
	userId: string,
): Option.Option<OrgMember> => Arr.findFirst(members ?? [], (member) => member.userId === userId)
