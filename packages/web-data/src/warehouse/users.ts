// The warehouse reads behind the users directory (`/users`). The API returns epoch-ms times.

import { Effect, Schema } from "effect"
import {
	EndUserId,
	ServiceNamespace,
	UserDetailRequest,
	UsersFacetsRequest,
	UsersListRequest,
} from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

/** The API's own bounds, so an over-long value is a load error here instead of a throw in its request class. */
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))

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
		Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
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

const UserDetailInput = Schema.Struct({ ...UsersWindowInput.fields, userId: EndUserId })
export type UserDetailInput = typeof UserDetailInput.Encoded

const detailRequest = (input: typeof UserDetailInput.Type) =>
	new UserDetailRequest({ ...windowOf(input), userId: input.userId })

/** One user's identity and totals; `profile` is `null` when nothing in the window carries them. */
export const getUserProfile = Effect.fn("Users.profile")(function* ({ data }: { data: UserDetailInput }) {
	const input = yield* decodeInput(UserDetailInput, data, "userProfile")
	return yield* runWarehouseQuery("userProfile", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.usersInternal.profile({ payload: detailRequest(input) })
		}),
	)
})

/** One user's replay sessions, product events, MCP sessions and the merged timeline. */
export const getUserActivity = Effect.fn("Users.activity")(function* ({ data }: { data: UserDetailInput }) {
	const input = yield* decodeInput(UserDetailInput, data, "userActivity")
	return yield* runWarehouseQuery("userActivity", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.usersInternal.activity({ payload: detailRequest(input) })
		}),
	)
})
