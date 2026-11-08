import { registerDriver } from "@maple/data-sources"
import type {
	CatalogEntry,
	ClerkDataSourceConfig,
	ClickHouseDataSourceConfig,
	CreateExternalDataSourceInput,
	DataSourceDriverError,
} from "@maple/domain/data-sources"
import { DataSourceQueryError } from "@maple/domain/data-sources"
import { Array as Arr, Effect, Layer, String as Str } from "effect"
import {
	DataSourceCallBudget,
	DataSourceDrivers,
} from "@maple/backend/services/data-sources/DataSourceDrivers"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { EVAL_TENANT } from "./utils"

/** What the fake drivers answer, and how often they ran. */
export interface DataSourceWorld {
	runs: number
	failWith: DataSourceDriverError | undefined
}

export const makeDataSourceWorld = (): DataSourceWorld => ({ runs: 0, failWith: undefined })

const table = (
	name: string,
	fields: CatalogEntry["fields"],
	extra: Partial<CatalogEntry> = {},
): CatalogEntry => ({
	name,
	kind: "table",
	fields,
	...extra,
})

const shopTables: ReadonlyArray<CatalogEntry> = [
	table(
		"shop.payments",
		[
			{ name: "inserted", type: "timestamp", nativeType: "DateTime" },
			{
				name: "status",
				type: "string",
				note: "paid, refunded, failed",
				sampleValues: ["paid", "failed"],
			},
			{ name: "amount", type: "number", note: "in cents" },
			{ name: "email", type: "string", pii: true, sampleValues: ["ada@example.com"] },
		],
		{ timeField: "inserted", rowEstimate: 120_000 },
	),
	table("shop.orders", [{ name: "id", type: "string" }], { rowEstimate: 50_000 }),
]

/** `wide` has 150 tables, more than one describe page. */
const catalogFor = (database: string): ReadonlyArray<CatalogEntry> =>
	database === "wide"
		? Arr.makeBy(150, (i) =>
				table(`wide.t${Str.padStart(3, "0")(String(i))}`, [{ name: "id", type: "string" }]),
			)
		: shopTables

const sqlDriver = (world: DataSourceWorld) =>
	registerDriver<"clickhouse">({
		kind: "clickhouse",
		queryLanguage: "sql:clickhouse",
		validateConnection: (input) =>
			Effect.succeed({
				config: {
					_tag: "clickhouse",
					url: input._tag === "clickhouse" ? input.url : "",
					user: "reader",
					database: input._tag === "clickhouse" ? input.database : "",
				} satisfies ClickHouseDataSourceConfig,
				secret: "pw",
			}),
		test: () => Effect.succeed({ warnings: [] }),
		// The `broken` database cannot be read, so its source is saved without a catalog.
		catalog: (connection) =>
			connection.config.database === "broken"
				? Effect.fail(new DataSourceQueryError({ message: "Access denied to system.tables" }))
				: Effect.succeed({
						entries: catalogFor(connection.config.database),
						// Multi-line, as the ClickHouse driver writes them.
						examples: [
							{
								title: "Payments\nper hour",
								query: { _tag: "sql", sql: "SELECT count() AS n\nFROM shop.payments" },
							},
						],
						truncated: false,
					}),
		prepare: (_connection, query) =>
			Effect.succeed({
				summary: { _tag: "sql", sql: query._tag === "sql" ? query.sql : "" },
				run: () =>
					Effect.suspend(() => {
						world.runs += 1
						return world.failWith === undefined
							? Effect.succeed({
									columns: [
										{ name: "status", type: "string" },
										{ name: "n", type: "number" },
									],
									rows: [
										{ status: "failed", n: 42 },
										{ status: "paid", n: 900 },
									],
									truncated: false,
								})
							: Effect.fail(world.failWith)
					}),
			}),
	})

const apiDriver = (world: DataSourceWorld) =>
	registerDriver<"clerk">({
		kind: "clerk",
		queryLanguage: "resource",
		validateConnection: () =>
			Effect.succeed({
				config: { _tag: "clerk", instance: "production" } satisfies ClerkDataSourceConfig,
				secret: "sk",
			}),
		test: () => Effect.succeed({ warnings: [] }),
		catalog: () =>
			Effect.succeed({
				entries: [
					{
						name: "users",
						kind: "resource",
						timeField: "created_at",
						fields: [
							{
								name: "created_at",
								type: "timestamp",
								note: "Signup time",
								capabilities: { filter: "server", sort: true, group: true, measure: false },
							},
						],
					},
				],
				examples: [
					{
						title: "Signups",
						query: { _tag: "resource", resource: "users", measure: { fn: "count" } },
					},
				],
				truncated: false,
			}),
		prepare: () =>
			Effect.succeed({
				summary: {
					_tag: "resource",
					strategy: "count",
					calls: 1,
					maxRows: 0,
					description: "1 count call",
				},
				run: () =>
					Effect.sync(() => {
						world.runs += 1
						return {
							columns: [{ name: "count", type: "number" }],
							rows: [{ count: 17 }],
							truncated: false,
						}
					}),
			}),
	})

/** The service over the fake drivers, as the eval runtime takes it. */
export const fakeDataSources = (world: DataSourceWorld) =>
	ExternalDataSourceService.layer.pipe(
		Layer.provide(DataSourceDrivers.fromList([sqlDriver(world), apiDriver(world)])),
		Layer.provide(DataSourceCallBudget.unlimited),
	)

const sql = (
	name: string,
	environment: CreateExternalDataSourceInput["environment"],
	database: string,
	extra: Partial<CreateExternalDataSourceInput> = {},
): CreateExternalDataSourceInput => ({
	name,
	description: `Storefront ${environment} database: orders and payments`,
	environment,
	connection: {
		_tag: "clickhouse",
		url: "https://ch.example.com:8443",
		user: "reader",
		database,
		password: "pw",
	},
	...extra,
})

export const DATA_SOURCE_SEED: ReadonlyArray<CreateExternalDataSourceInput> = [
	sql("shop-prod", "production", "shop"),
	sql("shop-staging", "staging", "shop"),
	sql("warehouse-wide", "production", "wide"),
	sql("secret-db", "production", "shop", { agentAccess: false }),
	sql("finance-archive", "production", "broken", { description: "Old finance archive: ledgers" }),
	{
		name: "clerk-prod",
		description: "Production user accounts and organizations",
		environment: "production",
		connection: { _tag: "clerk", secretKey: "sk_live_x" },
	},
]

/** Creates every seed source through the service, as an admin would. */
export const seedDataSources = Effect.gen(function* () {
	const service = yield* ExternalDataSourceService
	yield* Effect.forEach(
		DATA_SOURCE_SEED,
		(input) => service.create(EVAL_TENANT.orgId, EVAL_TENANT.userId, input),
		{
			discard: true,
		},
	)
})
