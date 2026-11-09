import { Array as Arr } from "effect"

// Tables of the data source world, shared by the static catalogs the playground stores and the
// SQL that seeds the Docker ClickHouse (`scripts/data-source-world-ch.sh`), so both agree.

export interface WorldColumn {
	readonly name: string
	readonly type: string
	readonly comment?: string
}

export interface WorldTable {
	readonly database: string
	readonly name: string
	readonly comment?: string
	/** Roughly what `system.tables.total_rows` reports after seeding. */
	readonly rows: number
	readonly orderBy: ReadonlyArray<string>
	readonly columns: ReadonlyArray<WorldColumn>
	/** A SELECT producing the rows in column order; none leaves the table empty. */
	readonly insert?: string
}

const DAY = 86_400
/**
 * `n` and `off` (seconds before now) on a grid of `step`, skipping 3 hours either side of the
 * 1, 7 and 30 day marks so counts over those windows hold for 3 hours after seeding.
 */
export const grid = (step: number, count: number) =>
	`(SELECT number AS n, number * ${step} + ${step / 2} AS off FROM numbers(${count}) WHERE NOT (${Arr.join(
		Arr.map([DAY, 7 * DAY, 30 * DAY], (mark) => `abs(toInt64(off) - ${mark}) < 10800`),
		" OR ",
	)}))`

export const col = (name: string, type: string, comment?: string): WorldColumn =>
	comment === undefined ? { name, type } : { name, type, comment }

const PAYMENT_STATUS = "multiIf(n % 11 = 0, 'failed', n % 29 = 0, 'refunded', 'paid')"
const ORDER_STATUS = "multiIf(n % 11 = 0, 'cancelled', n % 29 = 0, 'refunded', 'completed')"

/** The storefront: prod has 45 days of payments every 20 minutes; staging is sparse test data. */
export const shopTables = (env: "prod" | "staging"): ReadonlyArray<WorldTable> => {
	const prod = env === "prod"
	const rows = prod ? grid(1200, 3240) : grid(7200, 540)
	const customers = prod ? 500 : 50
	const amount = prod ? "1500 + (n * 7919) % 18000" : "100 + (n * 37) % 900"
	const countries = prod
		? "['US','US','US','DE','DE','GB','GB','FR','CA','BR','JP','AU']"
		: "['NL','SE','US']"
	return [
		{
			database: "shop",
			name: "payments",
			comment: "Card payments, one row per charge attempt",
			rows: prod ? 3200 : 535,
			orderBy: ["inserted"],
			columns: [
				col("id", "UInt64"),
				col("inserted", "DateTime", "When the charge was attempted (UTC)"),
				col("order_id", "UInt64", "shop.orders.id"),
				col("customer_id", "UInt32", "shop.customers.id"),
				col("status", "Enum8('paid' = 1, 'refunded' = 2, 'failed' = 3)"),
				col("amount", "UInt32", "Amount in cents (USD). Divide by 100 for dollars."),
				col("currency", "LowCardinality(String)"),
				col("card_brand", "LowCardinality(String)"),
			],
			insert: `SELECT n + 1, now() - off, n + 100001, (n * 31) % ${customers} + 1, ${PAYMENT_STATUS}, ${amount}, 'USD', ['visa','mastercard','amex'][n % 3 + 1] FROM ${rows}`,
		},
		{
			database: "shop",
			name: "orders",
			comment: "Storefront orders; each has one payment in shop.payments",
			rows: prod ? 3200 : 535,
			orderBy: ["created_at"],
			columns: [
				col("id", "UInt64"),
				col("created_at", "DateTime"),
				col("customer_id", "UInt32", "shop.customers.id"),
				col("total_cents", "UInt32", "Order total in cents (USD)"),
				col("status", "Enum8('completed' = 1, 'refunded' = 2, 'cancelled' = 3)"),
				col("items", "UInt8"),
			],
			insert: `SELECT n + 100001, now() - off - 30, (n * 31) % ${customers} + 1, ${amount}, ${ORDER_STATUS}, n % 4 + 1 FROM ${rows}`,
		},
		{
			database: "shop",
			name: "customers",
			comment: "Storefront customers",
			rows: customers,
			orderBy: ["id"],
			columns: [
				col("id", "UInt32"),
				col("created_at", "DateTime"),
				col("email", "String"),
				col("country", "LowCardinality(String)", "ISO 3166-1 alpha-2 country code"),
				col("plan", "LowCardinality(String)"),
			],
			insert: `SELECT number + 1, now() - (number * 7200 + 3600), concat('buyer', toString(number + 1), '@example.com'), ${countries}[number % ${prod ? 12 : 3} + 1], ['free','plus'][number % 2 + 1] FROM numbers(${customers})`,
		},
	]
}

/** Billing: invoices every 6 hours for 120 days; 1,000 subscriptions, 714 active in prod. */
export const billingTables = (env: "prod" | "dev"): ReadonlyArray<WorldTable> => {
	const prod = env === "prod"
	const invoices = prod ? 480 : 20
	const subs = prod ? 1000 : 30
	return [
		{
			database: "billing",
			name: "invoices",
			comment: "Customer invoices issued by the billing system",
			rows: invoices,
			orderBy: ["issued_at"],
			columns: [
				col("id", "String"),
				col("customer_id", "UInt32"),
				col("issued_at", "DateTime"),
				col("due_at", "DateTime"),
				col("amount_cents", "UInt64", "Invoice total in cents (USD)"),
				col("status", "Enum8('draft' = 1, 'open' = 2, 'paid' = 3, 'void' = 4, 'uncollectible' = 5)"),
			],
			insert: `SELECT concat('in_', toString(n)), n % 400 + 1, now() - off, now() - off + 1209600, 2900 + (n * 4111) % 50000, ['paid','paid','paid','open','void','draft','uncollectible'][n % 7 + 1] FROM ${grid(21600, invoices)}`,
		},
		{
			database: "billing",
			name: "subscriptions",
			comment: "One row per subscription; canceled ones keep their row",
			rows: subs,
			orderBy: ["started_at"],
			columns: [
				col("id", "String"),
				col("customer_id", "UInt32"),
				col("plan", "LowCardinality(String)"),
				col("status", "Enum8('active' = 1, 'canceled' = 2)"),
				col("started_at", "DateTime"),
				col("canceled_at", "Nullable(DateTime)"),
				col("mrr_cents", "UInt32", "Monthly recurring revenue in cents"),
			],
			insert: prod
				? "SELECT concat('sub_', toString(number)), number % 400 + 1, ['starter','team','business'][number % 3 + 1], if(number % 7 IN (0, 3), 'canceled', 'active'), now() - (number * 25000 + 7200), if(number % 7 IN (0, 3), now() - number * 900, NULL), [2900, 9900, 29900][number % 3 + 1] FROM numbers(1000)"
				: "SELECT concat('sub_test_', toString(number)), number + 1, 'starter', if(number % 2 = 0, 'active', 'canceled'), now() - number * 86400, NULL, 100 FROM numbers(30)",
		},
	]
}
