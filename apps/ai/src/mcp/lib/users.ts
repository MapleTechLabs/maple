import { Effect, Schema, Array as Arr, String as Str } from "effect"
import { McpInvalidInputError } from "../tools/types"

/** A list filter, trimmed; an empty list is no filter. */
export const listFilter = (values: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined => {
	const entries = Arr.filter(
		Arr.map(values ?? [], (value) => Str.trim(value)),
		Str.isNonEmpty,
	)
	return entries.length === 0 ? undefined : entries
}

/** The users read's request, or invalid input naming its caps (50 namespaces or groups, 200-char search). */
export const decodeUsersRequest = <S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	tool: string,
	input: unknown,
) =>
	Schema.decodeUnknownEffect(schema)(input).pipe(
		Effect.mapError(
			(error) =>
				new McpInvalidInputError({
					message: `${tool}: a filter is out of range (at most 50 namespaces or groups, search up to 200 characters): ${error.message}`,
				}),
		),
	)

/** How a user reads in a table or a next-call reason: their name, else email, else id. */
export const userLabel = (user: {
	readonly userId: string
	readonly name: string | null
	readonly email: string | null
}): string => user.name ?? user.email ?? user.userId

/** A user's group as `Acme (grp_1)`, the id alone when it has no name, `undefined` without one. */
export const groupLabel = (user: {
	readonly groupId: string | null
	readonly groupName: string | null
}): string | undefined =>
	user.groupId === null
		? undefined
		: user.groupName === null
			? user.groupId
			: `${user.groupName} (${user.groupId})`

/** `name / email`, the parts that are set, or `-`. */
export const nameAndEmail = (user: {
	readonly name: string | null
	readonly email: string | null
}): string => {
	const parts = Arr.filter([user.name ?? "", user.email ?? ""], Str.isNonEmpty)
	return parts.length === 0 ? "-" : Arr.join(parts, " / ")
}
