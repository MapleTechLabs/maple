import type { CreateExternalDataSourceInput } from "@maple/domain/data-sources"
import { Array as Arr, String as Str } from "effect"
import { billingTables, shopTables, type WorldTable } from "./tables"
import { analyticsTables, iotTables, legacyTables, payrollTables, smallTables } from "./tables-more"

/** Two ClickHouse servers: staging and development copies reuse database names (`shop`, `billing`). */
export type WorldServer = "main" | "staging"
export const SERVER_HOSTS = {
	main: "ch-main.acme-data.example.com",
	staging: "ch-staging.acme-data.example.com",
} as const satisfies Record<WorldServer, string>

export interface ClickHouseWorldSource {
	readonly _tag: "clickhouse"
	readonly input: Omit<CreateExternalDataSourceInput, "connection">
	readonly server: WorldServer
	readonly database: string
	/** The source's own ClickHouse user, granted SELECT on its database only. */
	readonly user: string
	readonly password: string
	readonly tables: ReadonlyArray<WorldTable>
}

export interface ClerkWorldSource {
	readonly _tag: "clerk"
	readonly input: Omit<CreateExternalDataSourceInput, "connection">
	readonly secretKey: string
}

export type WorldSource = ClickHouseWorldSource | ClerkWorldSource

const ch = (
	name: string,
	environment: CreateExternalDataSourceInput["environment"],
	description: string,
	tags: ReadonlyArray<string>,
	server: WorldServer,
	tables: ReadonlyArray<WorldTable>,
	extra: Partial<CreateExternalDataSourceInput> = {},
): ClickHouseWorldSource => ({
	_tag: "clickhouse",
	input: { name, description, environment, tags: [...tags], ...extra },
	server,
	database: tables[0]?.database ?? "default",
	user: `ds_${Str.replaceAll("-", "_")(name)}`,
	password: `pw_${Str.replaceAll("-", "_")(name)}`,
	tables,
})

export const CLERK_PROD_KEY = "sk_live_acmeProdWorld01"
export const CLERK_DEV_KEY = "sk_test_acmeDevWorld01"

export const WORLD_SOURCES: ReadonlyArray<WorldSource> = [
	ch(
		"shop-prod",
		"production",
		"Production storefront database: orders, payments and customers. Source of truth for revenue.",
		["shop", "revenue"],
		"main",
		shopTables("prod"),
	),
	ch(
		"shop-staging",
		"staging",
		"Staging copy of the storefront schema with synthetic test orders and payments.",
		["shop"],
		"staging",
		shopTables("staging"),
	),
	ch(
		"analytics",
		"production",
		"Product and marketing site analytics events (page views, clicks) from anonymous visitors.",
		["web", "marketing"],
		"main",
		analyticsTables,
	),
	ch(
		"billing",
		"production",
		"Billing system of record: invoices and subscriptions (plans, MRR, cancellations).",
		["finance", "revenue"],
		"main",
		billingTables("prod"),
	),
	ch(
		"billing-dev",
		"development",
		"Development billing database with fake invoices and subscriptions for local testing.",
		["finance"],
		"staging",
		billingTables("dev"),
	),
	ch(
		"warehouse-legacy",
		"production",
		"Old data warehouse from the 2019 ERP migration: about 400 staging, backup and import tables. Mostly unused.",
		["legacy"],
		"main",
		legacyTables,
	),
	ch(
		"iot-metrics",
		"production",
		"Temperature and humidity sensor readings from warehouses, cold rooms and offices.",
		["iot", "facilities"],
		"main",
		iotTables,
	),
	ch("people-ops", "production", "HR data: employees and monthly payroll.", ["hr"], "main", payrollTables, {
		agentAccess: false,
	}),
	ch(
		"support-desk",
		"production",
		"Customer support tickets (status, priority, channel).",
		["support"],
		"main",
		smallTables.support,
	),
	ch(
		"marketing",
		"production",
		"Marketing campaigns and email sends.",
		["marketing"],
		"main",
		smallTables.marketing,
	),
	ch(
		"feature-flags",
		"production",
		"Feature flag evaluations by flag and variant.",
		["product"],
		"main",
		smallTables.flags,
	),
	ch("crm", "production", "Sales CRM: accounts and deals.", ["sales"], "main", smallTables.crm),
	ch(
		"inventory",
		"production",
		"Stock levels per SKU and warehouse.",
		["ops"],
		"main",
		smallTables.inventory,
	),
	ch(
		"shipping",
		"production",
		"Shipments and carrier delivery status for storefront orders.",
		["ops"],
		"main",
		smallTables.shipping,
	),
	ch(
		"fraud-signals",
		"production",
		"Fraud risk scores and decisions per payment attempt.",
		["risk"],
		"main",
		smallTables.fraud,
	),
	ch(
		"site-search",
		"production",
		"Search queries typed on the storefront and whether a result was clicked.",
		["web"],
		"main",
		smallTables.search,
	),
	{
		_tag: "clerk",
		input: {
			name: "clerk-prod",
			description:
				"Production Clerk instance: our customers' user accounts and organizations (signups, sign-ins).",
			environment: "production",
			tags: ["auth", "users"],
		},
		secretKey: CLERK_PROD_KEY,
	},
	{
		_tag: "clerk",
		input: {
			name: "clerk-dev",
			description: "Development Clerk instance used by QA and local testing.",
			environment: "development",
			tags: ["auth"],
		},
		secretKey: CLERK_DEV_KEY,
	},
]

export const clickHouseSources = Arr.filter(
	WORLD_SOURCES,
	(source): source is ClickHouseWorldSource => source._tag === "clickhouse",
)
