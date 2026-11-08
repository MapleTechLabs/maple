import { Array as Arr, Effect, Redacted, Schema, String as Str } from "effect"
import {
	type ClerkDataSourceConfig,
	type CatalogExample,
	DataSourceConnectionError,
	DataSourceValidationError,
} from "@maple/domain/data-sources"
import { type DriverConnection, registerDriver } from "../../port"
import { catalogEntryOf, prepareResourceQuery } from "../../resource-engine"
import type { ResourceDefinition } from "../../resource-engine/types"
import { clerkGet } from "./http"
import { organizationsResource } from "./organizations"
import { usersResource } from "./users"

export { CLERK_API_URL } from "./http"

const KEY_PATTERN = /^sk_(live|test)_[A-Za-z0-9]+$/

export const WRITE_KEY_WARNING =
	"Clerk secret keys can create, change and delete users. Maple only calls a fixed list of read (GET) endpoints with it."

/** Every resource the driver serves, bound to one key. */
export const clerkResources = (secret: Redacted.Redacted): ReadonlyArray<ResourceDefinition> => [
	usersResource(secret),
	organizationsResource(secret),
]

/** The catalog never depends on the key; a placeholder keeps one source of truth for the fields. */
const DECLARED = clerkResources(Redacted.make(""))

export const CLERK_EXAMPLES: ReadonlyArray<CatalogExample> = [
	{
		title: "Signups per day",
		query: {
			_tag: "resource",
			resource: "users",
			measure: { fn: "count" },
			groupBy: { time: "created_at" },
		},
	},
	{
		title: "Users who signed in within the window, newest first",
		query: {
			_tag: "resource",
			resource: "users",
			filters: [{ field: "last_sign_in_at", op: "within_window" }],
			select: ["id", "created_at", "last_sign_in_at"],
			orderBy: { field: "last_sign_in_at", dir: "desc" },
			limit: 100,
		},
	},
	{
		title: "Total users (all time)",
		query: {
			_tag: "resource",
			resource: "users",
			measure: { fn: "count" },
			filters: [{ field: "created_at", op: "gte", value: 0 }],
		},
	},
	{
		title: "Users active within the window (not a per-day history)",
		query: {
			_tag: "resource",
			resource: "users",
			measure: { fn: "count" },
			filters: [{ field: "last_active_at", op: "within_window" }],
		},
	},
]

const secretOf = (connection: DriverConnection<ClerkDataSourceConfig>) =>
	connection.secret === null
		? Effect.fail(
				new DataSourceConnectionError({
					message: "No Clerk secret key is stored for this source",
					reason: "config",
				}),
			)
		: Effect.succeed(connection.secret)

const invalidKey = () =>
	new DataSourceValidationError({
		message: "A Clerk secret key starts with `sk_live_` or `sk_test_`",
		field: "secretKey",
	})

export const clerkDriver = registerDriver<"clerk">({
	kind: "clerk",
	queryLanguage: "resource",
	validateConnection: (input, previous) => {
		if (input._tag !== "clerk")
			return Effect.fail(new DataSourceValidationError({ message: "Expected a Clerk connection" }))
		const key = Str.trim(input.secretKey ?? "")
		if (key === "") {
			return previous === null
				? Effect.fail(
						new DataSourceValidationError({
							message: "Paste the instance's secret key",
							field: "secretKey",
						}),
					)
				: Effect.succeed({ config: previous, secret: null })
		}
		const match = KEY_PATTERN.exec(key)
		if (match === null) return Effect.fail(invalidKey())
		const config: ClerkDataSourceConfig = {
			_tag: "clerk",
			instance: match[1] === "live" ? "production" : "development",
		}
		return Effect.succeed({ config, secret: key })
	},
	test: (connection, context) =>
		Effect.gen(function* () {
			const secret = yield* secretOf(connection)
			yield* context.spend(1)
			yield* clerkGet(secret, "/users/count", [], Schema.Struct({ total_count: Schema.Number }))
			return { warnings: [WRITE_KEY_WARNING] }
		}),
	catalog: () =>
		Effect.succeed({
			entries: Arr.map(DECLARED, catalogEntryOf),
			examples: CLERK_EXAMPLES,
			truncated: false,
		}),
	prepare: (connection, query, request, catalog) =>
		Effect.flatMap(secretOf(connection), (secret) =>
			prepareResourceQuery(clerkResources(secret), query, request, catalog),
		),
})
