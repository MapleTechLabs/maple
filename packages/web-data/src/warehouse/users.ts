// The warehouse reads behind the users directory (`/users`). The API returns epoch-ms times.

import { Effect, Schema } from "effect"
import { ServiceNamespace, UsersFacetsRequest, UsersListRequest } from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

/** The API's own bounds, so an over-long value is a load error here instead of a throw in its request class. */
export const USERS_SEARCH_MAX_LENGTH = 200
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(USERS_SEARCH_MAX_LENGTH))

const UsersWindowInput = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	/** The namespaces in effect: the org pin, else the rail's picks. */
	namespaces: Schema.optional(Schema.Array(ServiceNamespace).check(Schema.isMaxLength(50))),
})
export type UsersWindowInput = typeof UsersWindowInput.Encoded

const UsersListInput = Schema.Struct({
	...UsersWindowInput.fields,
	search: Schema.optional(text),
	hasErrors: Schema.optional(Schema.Boolean),
	hasReplay: Schema.optional(Schema.Boolean),
	groups: Schema.optional(
		Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))).check(
			Schema.isMaxLength(50),
		),
	),
	limit: Schema.optional(Schema.Number),
})
export type UsersListInput = typeof UsersListInput.Encoded

/** Absent or empty filters stay absent on the wire. */
const windowOf = (input: typeof UsersWindowInput.Type) => ({
	startTime: input.startTime,
	endTime: input.endTime,
	...(input.namespaces !== undefined && input.namespaces.length > 0 && { namespaces: input.namespaces }),
})

export const listUsers = Effect.fn("Users.list")(function* ({ data }: { data: UsersListInput }) {
	const input = yield* decodeInput(UsersListInput, data, "listUsers")
	return yield* runWarehouseQuery("listUsers", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.usersInternal.list({
				payload: new UsersListRequest({
					...windowOf(input),
					...(input.search !== undefined && { search: input.search }),
					...(input.hasErrors === true && { hasErrors: true }),
					...(input.hasReplay === true && { hasReplay: true }),
					...(input.groups !== undefined && input.groups.length > 0 && { groups: input.groups }),
					...(input.limit !== undefined && { limit: input.limit }),
				}),
			})
		}),
	)
})

export const getUsersFacets = Effect.fn("Users.facets")(function* ({ data }: { data: UsersWindowInput }) {
	const input = yield* decodeInput(UsersWindowInput, data, "usersFacets")
	return yield* runWarehouseQuery("usersFacets", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.usersInternal.facets({ payload: new UsersFacetsRequest(windowOf(input)) })
		}),
	)
})
