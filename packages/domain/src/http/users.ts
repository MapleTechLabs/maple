import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { ServiceNamespace } from "../primitives"
import { TinybirdDateTime } from "../query-engine"
import { AuditedRead } from "./audit-log"
import { SessionAuthorization } from "./current-tenant"
import { warehouseReadHttpErrors } from "./warehouse"

// End users endpoint schemas (`/users`): the people Maple's customers identified with `identify()`
// or a `user.id` span attribute, read by `ch/queries/users.ts`. Times are epoch milliseconds.

const searchText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const groupId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))

const windowFields = {
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	/** The namespaces in effect: the org pin, else the rail's picks. Empty or absent is every one. */
	namespaces: Schema.optionalKey(Schema.Array(ServiceNamespace).check(Schema.isMaxLength(50))),
}

/** A signal Maple holds for a user. */
export const UserSignalKind = Schema.Literals(["replay", "events", "mcp"])
export type UserSignalKind = typeof UserSignalKind.Type

export const UserListItem = Schema.Struct({
	userId: Schema.String,
	name: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	groupId: Schema.NullOr(Schema.String),
	namespaces: Schema.Array(Schema.String),
	firstSeenMs: Schema.Number,
	lastSeenMs: Schema.Number,
	sessions: Schema.Number,
	errors: Schema.Number,
	requests: Schema.Number,
	signals: Schema.Array(UserSignalKind),
})
export type UserListItem = typeof UserListItem.Type

/** `hasErrors` / `hasReplay` only narrow: `true` keeps the users with one, absent keeps everyone. */
export class UsersListRequest extends Schema.Class<UsersListRequest>("UsersListRequest")({
	...windowFields,
	search: Schema.optionalKey(searchText),
	hasErrors: Schema.optionalKey(Schema.Literal(true)),
	hasReplay: Schema.optionalKey(Schema.Literal(true)),
	groups: Schema.optionalKey(Schema.Array(groupId).check(Schema.isMaxLength(50))),
	limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
}) {}

export class UsersListResponse extends Schema.Class<UsersListResponse>("UsersListResponse")({
	users: Schema.Array(UserListItem),
}) {}

const FacetOption = Schema.Struct({ name: Schema.String, count: Schema.Number })

/** `namespaces` is the org pin only: the rail's picks never change the facets. */
export class UsersFacetsRequest extends Schema.Class<UsersFacetsRequest>("UsersFacetsRequest")({
	...windowFields,
}) {}

export class UsersFacetsResponse extends Schema.Class<UsersFacetsResponse>("UsersFacetsResponse")({
	/** Users per namespace over every namespace; empty under a pin. */
	namespaces: Schema.Array(FacetOption),
	groups: Schema.Array(FacetOption),
	withErrors: Schema.Number,
	withReplay: Schema.Number,
	identified: Schema.Number,
	/** Users with any signal in the 24 hours before the request. */
	activeToday: Schema.Number,
	/** Visitors in the window that never carried a user id. */
	anonymousVisitors: Schema.Number,
}) {}

export class UsersInternalApiGroup extends HttpApiGroup.make("usersInternal")
	.add(
		HttpApiEndpoint.post("list", "/list", {
			payload: UsersListRequest,
			success: UsersListResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("facets", "/facets", {
			payload: UsersFacetsRequest,
			success: UsersFacetsResponse,
			error: warehouseReadHttpErrors,
		}),
	)
	.prefix("/internal/users")
	.middleware(SessionAuthorization)
	.annotate(AuditedRead, "telemetry.read") {}
