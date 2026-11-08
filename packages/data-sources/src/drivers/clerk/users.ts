import { Array as Arr, Effect, Option, type Redacted, Schema, String as Str } from "effect"
import type { CatalogFieldCapabilities } from "@maple/domain/data-sources"
import type { ResourceDefinition, ResourceFieldDef, ResourceRow } from "../../resource-engine/types"
import { clerkGet, type ClerkEndpoints } from "./http"
import { type ParamMapping, serverOpsOf, toParams } from "./params"

type UserParam = ClerkEndpoints["/users/count"]
const Nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

export const ClerkUserWire = Schema.Struct({
	id: Schema.String,
	created_at: Schema.Number,
	updated_at: Schema.Number,
	last_active_at: Nullable(Schema.Number),
	last_sign_in_at: Nullable(Schema.Number),
	username: Nullable(Schema.String),
	first_name: Nullable(Schema.String),
	last_name: Nullable(Schema.String),
	external_id: Nullable(Schema.String),
	primary_email_address_id: Nullable(Schema.String),
	primary_phone_number_id: Nullable(Schema.String),
	email_addresses: Schema.optionalKey(
		Schema.Array(Schema.Struct({ id: Schema.String, email_address: Schema.String })),
	),
	phone_numbers: Schema.optionalKey(
		Schema.Array(Schema.Struct({ id: Schema.String, phone_number: Schema.String })),
	),
	banned: Schema.optionalKey(Schema.Boolean),
	locked: Schema.optionalKey(Schema.Boolean),
	two_factor_enabled: Schema.optionalKey(Schema.Boolean),
	password_enabled: Schema.optionalKey(Schema.Boolean),
})
export type ClerkUserWire = Schema.Schema.Type<typeof ClerkUserWire>

const TotalCount = Schema.Struct({ total_count: Schema.Number })

const MAPPINGS = new Map<string, ParamMapping<UserParam>>([
	["id", { values: "user_id" }],
	["created_at", { range: { after: "created_at_after", before: "created_at_before" } }],
	["last_active_at", { range: { after: "last_active_at_after", before: "last_active_at_before" } }],
	["last_sign_in_at", { range: { after: "last_sign_in_at_after", before: "last_sign_in_at_before" } }],
	["primary_email", { values: "email_address", contains: "email_address_query" }],
	["username", { values: "username", contains: "username_query" }],
	["external_id", { values: "external_id" }],
	["organization_id", { values: "organization_id" }],
	["banned", { bool: "banned" }],
])

/** `order_by` names for the sortable fields. */
const ORDER_BY = new Map<string, string>([
	["created_at", "created_at"],
	["updated_at", "updated_at"],
	["last_active_at", "last_active_at"],
	["last_sign_in_at", "last_sign_in_at"],
	["username", "username"],
	["primary_email", "email_address"],
	["first_name", "first_name"],
	["last_name", "last_name"],
])

const caps = (name: string, extra: Partial<CatalogFieldCapabilities>): CatalogFieldCapabilities => ({
	filter: MAPPINGS.has(name) ? "server" : "client",
	sort: ORDER_BY.has(name),
	group: false,
	measure: false,
	...extra,
})

const field = (
	name: string,
	type: ResourceFieldDef["type"],
	rest: Omit<Partial<ResourceFieldDef>, "capabilities" | "serverOps"> & {
		readonly capabilities?: Partial<CatalogFieldCapabilities>
	} = {},
): ResourceFieldDef => {
	const mapping = MAPPINGS.get(name)
	return {
		...rest,
		name,
		type,
		capabilities: caps(name, rest.capabilities ?? {}),
		serverOps: mapping === undefined ? [] : serverOpsOf(mapping),
	}
}

const LATEST_ONLY =
	"Clerk keeps only the latest value per user, so this answers 'users active since X' or 'within the window', never a per-day history (past days are overwritten)."

export const USER_FIELDS: ReadonlyArray<ResourceFieldDef> = [
	field("id", "string", { capabilities: { measure: true } }),
	field("created_at", "timestamp", {
		note: "Signup time: when the user was created. Use it for signups and new users per day.",
		capabilities: { measure: true },
	}),
	field("updated_at", "timestamp"),
	field("last_active_at", "timestamp", {
		latestOnly: true,
		note: `Latest session activity. ${LATEST_ONLY}`,
	}),
	field("last_sign_in_at", "timestamp", { latestOnly: true, note: `Latest sign-in. ${LATEST_ONLY}` }),
	field("primary_email", "string", { pii: true }),
	field("email_domain", "string", {
		note: "Domain of the primary email, e.g. example.com.",
		capabilities: { group: true },
	}),
	field("primary_phone", "string", { pii: true }),
	field("first_name", "string", { pii: true }),
	field("last_name", "string", { pii: true }),
	field("username", "string", { pii: true }),
	field("external_id", "string", { note: "Your app's own id for the user, when set." }),
	field("organization_id", "string", {
		filterOnly: true,
		note: "Filter only: users who are members of this organization.",
	}),
	field("banned", "boolean", { capabilities: { group: true } }),
	field("locked", "boolean", { capabilities: { group: true } }),
	field("two_factor_enabled", "boolean", { capabilities: { group: true } }),
	field("password_enabled", "boolean", { capabilities: { group: true } }),
]

export const userRow = (user: ClerkUserWire): ResourceRow => {
	const email = Option.getOrNull(
		Option.map(
			Arr.findFirst(user.email_addresses ?? [], (e) => e.id === user.primary_email_address_id),
			(e) => e.email_address,
		),
	)
	const phone = Option.getOrNull(
		Option.map(
			Arr.findFirst(user.phone_numbers ?? [], (p) => p.id === user.primary_phone_number_id),
			(p) => p.phone_number,
		),
	)
	return {
		id: user.id,
		created_at: user.created_at,
		updated_at: user.updated_at,
		last_active_at: user.last_active_at ?? null,
		last_sign_in_at: user.last_sign_in_at ?? null,
		primary_email: email,
		email_domain: email === null ? null : (Str.split("@")(email)[1] ?? null),
		primary_phone: phone,
		first_name: user.first_name ?? null,
		last_name: user.last_name ?? null,
		username: user.username ?? null,
		external_id: user.external_id ?? null,
		banned: user.banned ?? null,
		locked: user.locked ?? null,
		two_factor_enabled: user.two_factor_enabled ?? null,
		password_enabled: user.password_enabled ?? null,
	}
}

export const usersResource = (secret: Redacted.Redacted): ResourceDefinition => ({
	name: "users",
	note: "People who signed up to this Clerk instance. `created_at` is the signup time. Signups per time bucket are cheap (one total call each); anything else reads users page by page. There is no per-day activity history: daily active users cannot be answered, only how many were active within a window.",
	noun: { one: "user", many: "users" },
	timeField: "created_at",
	fields: USER_FIELDS,
	pageSize: 500,
	fetchPage: (request) =>
		Effect.gen(function* () {
			const filters = yield* toParams(MAPPINGS, request.filters)
			const order = request.orderBy === null ? undefined : ORDER_BY.get(request.orderBy.field)
			const users = yield* clerkGet(
				secret,
				"/users",
				[
					...filters,
					["limit", String(request.limit)],
					["offset", String(request.offset)],
					...(order === undefined || request.orderBy === null
						? []
						: [["order_by", `${request.orderBy.dir === "desc" ? "-" : "+"}${order}`] as const]),
				],
				Schema.Array(ClerkUserWire),
			)
			return Arr.map(users, userRow)
		}),
	count: (filters) =>
		Effect.gen(function* () {
			const params = yield* toParams(MAPPINGS, filters)
			const body = yield* clerkGet(secret, "/users/count", params, TotalCount)
			return body.total_count
		}),
})
