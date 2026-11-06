import { UserId } from "@maple/domain/http"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { clerkTry, currentClerkOrganization } from "../../../platform/clerk"

// The org's members as the on-call pickers and names read them: Clerk's memberships, first 100.

const PAGE_SIZE = 100

export const OrgMember = Schema.Struct({
	userId: UserId,
	name: Schema.String,
	email: Schema.String,
	/** `""` without an uploaded image: the warm initials tile stands in. */
	imageUrl: Schema.String,
})
export type OrgMember = typeof OrgMember.Type

const decodeUserId = Schema.decodeUnknownOption(UserId)

/** Every member with a user id, named by first and last name, else by email. */
export const listOrgMembers: Effect.Effect<ReadonlyArray<OrgMember>, string> = currentClerkOrganization.pipe(
	Effect.flatMap((organization) =>
		clerkTry("Couldn't load members", () =>
			organization.getMemberships({ initialPage: 1, pageSize: PAGE_SIZE }),
		),
	),
	Effect.mapBoth({
		onSuccess: (page) =>
			Arr.flatMap(page.data, (member): ReadonlyArray<OrgMember> => {
				const user = member.publicUserData
				const email = user?.identifier ?? ""
				const name = Arr.join(
					Arr.filter([user?.firstName, user?.lastName], (part): part is string => Boolean(part)),
					" ",
				)
				return Option.match(decodeUserId(user?.userId), {
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
			}),
		onFailure: (error) => error.message,
	}),
)

/** A member by id; someone who left the org reads as "A former member", and "Member" until they load. */
export const memberName = (members: ReadonlyArray<OrgMember> | null, userId: string): string =>
	members === null
		? "Member"
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
