import type { DataSourceDriver } from "@maple/data-sources"
import { CLERK_API_URL, clerkDriver } from "@maple/data-sources/clerk"
import { type FakeClerk, fakeClerkHttpClient, makeFakeClerk } from "@maple/data-sources/clerk/testing"
import {
	clickHouseCatalogEntry,
	clickHouseCatalogExamples,
	clickHouseDriver,
} from "@maple/data-sources/clickhouse"
import type { CatalogEntry, SourceCatalog } from "@maple/domain/data-sources"
import { Array as Arr, Effect, Layer, Option, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import {
	DataSourceCallBudget,
	DataSourceDrivers,
} from "@maple/backend/services/data-sources/DataSourceDrivers"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { EVAL_TENANT } from "../utils"
import { clerkDevUsers, clerkProdUsers } from "./clerk-users"
import type { WorldTable } from "./tables"
import {
	CLERK_DEV_KEY,
	CLERK_PROD_KEY,
	clickHouseSources,
	SERVER_HOSTS,
	WORLD_SOURCES,
	type WorldServer,
} from "./sources"

/** Docker ports of the two servers (`scripts/data-source-world-ch.sh`). */
export const CH_PORTS = { main: 18741, staging: 18742 } as const satisfies Record<WorldServer, number>

/** What `system.tables` and `system.columns` would answer for a world table. */
export const catalogEntryOf = (table: WorldTable): CatalogEntry =>
	clickHouseCatalogEntry(
		{
			database: table.database,
			name: table.name,
			engine: "MergeTree",
			total_rows: String(table.rows),
			comment: table.comment ?? "",
		},
		Arr.map(table.columns, (column) => ({
			database: table.database,
			table: table.name,
			name: column.name,
			type: column.type,
			comment: column.comment ?? "",
			is_in_sorting_key: Arr.contains(table.orderBy, column.name) ? 1 : 0,
		})),
	)

const catalogs = new Map<string, SourceCatalog>(
	Arr.map(clickHouseSources, (source) => {
		const entries = Arr.map(source.tables, catalogEntryOf)
		return [source.user, { entries, examples: clickHouseCatalogExamples(entries), truncated: false }]
	}),
)

/** The real ClickHouse driver for queries; test and catalog answer from the world's tables. */
const worldClickHouseDriver: DataSourceDriver = {
	...clickHouseDriver,
	test: () => Effect.succeed({ warnings: [] }),
	catalog: (connection) =>
		Effect.succeed(
			(connection.config._tag === "clickhouse" ? catalogs.get(connection.config.user) : undefined) ?? {
				entries: [],
				examples: [],
				truncated: false,
			},
		),
}

/** The world's Clerk instances, built per run so signups stay relative to now. */
export interface DataSourceWorldState {
	readonly clerkProd: FakeClerk
	readonly clerkDev: FakeClerk
	readonly clickHouse: boolean
}

export const makeDataSourceWorldState = (
	now: number = Date.now(),
	clickHouse: boolean = process.env.PLAYGROUND_CH === "1",
): DataSourceWorldState => ({
	clerkProd: makeFakeClerk({ secretKey: CLERK_PROD_KEY, users: clerkProdUsers(now) }),
	clerkDev: makeFakeClerk({ secretKey: CLERK_DEV_KEY, users: clerkDevUsers(now) }),
	clickHouse,
})

// Captured at import, before a fixture replaces `globalThis.fetch`.
const realFetch = globalThis.fetch

/** Dials the Docker server behind a world host; the driver still validates the public name. */
const dial =
	(enabled: boolean): typeof globalThis.fetch =>
	(input, init) => {
		const url = new URL(input instanceof Request ? input.url : input)
		const servers: ReadonlyArray<WorldServer> = ["main", "staging"]
		const server = Arr.findFirst(servers, (name) => SERVER_HOSTS[name] === url.hostname)
		if (!enabled || Option.isNone(server))
			return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))
		url.protocol = "http:"
		url.host = `127.0.0.1:${CH_PORTS[server.value]}`
		return realFetch(url, init)
	}

/** Clerk calls go to the fake that owns the key; everything else dials ClickHouse. */
const worldHttpClient = (state: DataSourceWorldState) =>
	Layer.effect(
		HttpClient.HttpClient,
		Effect.gen(function* () {
			const clerkClient = (fake: FakeClerk) =>
				Effect.provide(Effect.service(HttpClient.HttpClient), fakeClerkHttpClient(fake))
			const prod = yield* clerkClient(state.clerkProd)
			const dev = yield* clerkClient(state.clerkDev)
			const ch = yield* Effect.provide(Effect.service(HttpClient.HttpClient), FetchHttpClient.layer)
			return HttpClient.make((request, url) =>
				Str.startsWith(CLERK_API_URL)(url.href)
					? (request.headers["authorization"] === `Bearer ${CLERK_DEV_KEY}` ? dev : prod).execute(
							request,
						)
					: ch
							.execute(request)
							.pipe(Effect.provideService(FetchHttpClient.Fetch, dial(state.clickHouse))),
			)
		}),
	)

/** The service over the world: real drivers, fake Clerk, Docker ClickHouse when enabled. */
export const dataSourceWorldLayer = (state: DataSourceWorldState) =>
	Layer.effect(ExternalDataSourceService, ExternalDataSourceService.make).pipe(
		Layer.provide(DataSourceDrivers.fromList([worldClickHouseDriver, clerkDriver])),
		Layer.provide(DataSourceCallBudget.unlimited),
		Layer.provide(worldHttpClient(state)),
	)

/** Creates all 18 sources through the service, as an admin would. */
export const seedDataSourceWorld = Effect.gen(function* () {
	const service = yield* ExternalDataSourceService
	yield* Effect.forEach(
		WORLD_SOURCES,
		(source) =>
			service.create(EVAL_TENANT.orgId, EVAL_TENANT.userId, {
				...source.input,
				connection:
					source._tag === "clerk"
						? { _tag: "clerk", secretKey: source.secretKey }
						: {
								_tag: "clickhouse",
								url: `https://${SERVER_HOSTS[source.server]}:8443`,
								user: source.user,
								database: source.database,
								password: source.password,
							},
			}),
		{ discard: true },
	)
})
