import { Array as Arr, String as Str } from "effect"
import { col, grid, type WorldTable } from "./tables"

const table = (
	database: string,
	name: string,
	rows: number,
	orderBy: ReadonlyArray<string>,
	columns: WorldTable["columns"],
	insert?: string,
	comment?: string,
): WorldTable => {
	const base: WorldTable = { database, name, rows, orderBy, columns }
	const withInsert: WorldTable = insert === undefined ? base : { ...base, insert }
	return comment === undefined ? withInsert : { ...withInsert, comment }
}

export const analyticsTables: ReadonlyArray<WorldTable> = [
	table(
		"analytics",
		"events",
		8600,
		["event_time"],
		[
			col("event_time", "DateTime"),
			col("anonymous_id", "String", "Cookie id; there are no signed-in user ids here"),
			col("event_name", "LowCardinality(String)"),
			col("path", "String"),
			col("referrer", "String"),
		],
		`SELECT now() - off, concat('anon_', toString(n % 1700)), ['page_view','page_view','page_view','cta_click','docs_search'][n % 5 + 1], ['/','/pricing','/docs','/blog'][n % 4 + 1], ['google','direct','twitter',''][n % 4 + 1] FROM ${grid(300, 8640)}`,
		"Marketing site and docs page analytics. Anonymous visitors only.",
	),
]

const DEVICES = "['cold-room-1','cold-room-2','warehouse-a','warehouse-b','office-1','server-room']"
const BASE = "[4, 4, 16, 16, 21, 24]"
/** cold-room-2 climbs from 4 to 10 degrees over the last 3 days: a failing cooler. */
const TEMP = `if(d = 1 AND off < 259200, 4 + (259200 - off) / 259200 * 6, ${BASE}[d + 1] + if(d < 2, 0.3, 1.5) * sin(off / 13751))`

export const iotTables: ReadonlyArray<WorldTable> = [
	table(
		"iot",
		"readings",
		12096,
		["device_id", "ts"],
		[
			col("device_id", "LowCardinality(String)"),
			col("ts", "UInt32", "Unix epoch seconds (UTC), an integer, not a DateTime: use toDateTime(ts)"),
			col("temperature_c", "Float32", "Degrees Celsius"),
			col("humidity_pct", "Float32"),
		],
		`SELECT ${DEVICES}[d + 1], toUInt32(toUnixTimestamp(now()) - off), round(${TEMP}, 2), round(40 + 10 * cos(off / 20000), 1) FROM (SELECT number % 6 AS d, intDiv(number, 6) * 600 + 300 AS off FROM numbers(12096))`,
		"Sensor readings every 10 minutes per device. Time is ts, epoch seconds.",
	),
	table(
		"iot",
		"devices",
		6,
		["device_id"],
		[col("device_id", "String"), col("location", "String"), col("kind", "LowCardinality(String)")],
		`SELECT ${DEVICES}[number + 1], ['Berlin DC','Berlin DC','Hamburg','Hamburg','Berlin HQ','Berlin HQ'][number + 1], 'thermo-hygrometer' FROM numbers(6)`,
	),
]

export const payrollTables: ReadonlyArray<WorldTable> = [
	table(
		"hr",
		"payroll",
		1440,
		["pay_date"],
		[
			col("employee_id", "UInt32"),
			col("full_name", "String"),
			col("department", "LowCardinality(String)"),
			col("salary_cents", "UInt64", "Gross monthly salary in cents (EUR)"),
			col("pay_date", "Date"),
		],
		"SELECT number % 120 + 1, concat('Employee ', toString(number % 120 + 1)), ['eng','sales','ops'][number % 3 + 1], 500000 + (number % 120) * 2500, toDate(now()) - intDiv(number, 120) * 30 FROM numbers(1440)",
		"Monthly payroll runs per employee",
	),
]

const LEGACY_PREFIXES = [
	"etl_stage",
	"bak_2019",
	"tmp_import",
	"dim_old",
	"fact_old",
	"sync_cursor",
	"crm_export",
	"raw_feed",
]

/** 398 leftovers plus two that matter: the 2019 invoice archive and customer lifetime value. */
export const legacyTables: ReadonlyArray<WorldTable> = [
	table(
		"legacy",
		"invoices_archive_2019",
		5200,
		["issued_on"],
		[col("invoice_no", "String"), col("issued_on", "Date"), col("amount_eur", "Decimal(12, 2)")],
		"SELECT concat('2019-', toString(number)), toDate('2019-01-01') + number % 365, 20 + number % 500 FROM numbers(5200)",
		"Invoices from the pre-2020 ERP, read only",
	),
	table(
		"legacy",
		"customer_ltv",
		9000,
		["customer_id"],
		[col("customer_id", "UInt32"), col("ltv_eur", "Decimal(12, 2)"), col("computed_on", "Date")],
	),
	...Arr.makeBy(398, (i) =>
		table(
			"legacy",
			`${LEGACY_PREFIXES[i % LEGACY_PREFIXES.length]}_${Str.padStart(3, "0")(String(i))}`,
			0,
			["id"],
			[col("id", "UInt64"), col("payload", "String"), col("loaded_at", "DateTime")],
		),
	),
]

/** The small sources: real tables with a little data, there so the agent has to choose. */
export const smallTables = {
	support: [
		table(
			"support",
			"tickets",
			360,
			["created_at"],
			[
				col("id", "UInt32"),
				col("created_at", "DateTime"),
				col("status", "Enum8('open' = 1, 'pending' = 2, 'solved' = 3, 'closed' = 4)"),
				col("priority", "Enum8('low' = 1, 'normal' = 2, 'high' = 3, 'urgent' = 4)"),
				col("channel", "LowCardinality(String)"),
				col("subject", "String"),
			],
			`SELECT n, now() - off, ['open','pending','solved','closed'][n % 4 + 1], ['low','normal','normal','high','urgent'][n % 5 + 1], ['email','chat'][n % 2 + 1], ['Refund request','Payment failed','Cannot log in','Shipping delay'][n % 4 + 1] FROM ${grid(7200, 360)}`,
		),
	],
	marketing: [
		table(
			"marketing",
			"campaigns",
			24,
			["started_at"],
			[
				col("id", "UInt32"),
				col("name", "String"),
				col("channel", "LowCardinality(String)"),
				col("started_at", "DateTime"),
				col("budget_cents", "UInt64"),
			],
			"SELECT number, concat('Campaign ', toString(number)), ['email','search','social'][number % 3 + 1], now() - number * 604800, 100000 + number * 5000 FROM numbers(24)",
		),
		table(
			"marketing",
			"email_sends",
			0,
			["sent_at"],
			[
				col("sent_at", "DateTime"),
				col("campaign_id", "UInt32"),
				col("recipient_hash", "String"),
				col("opened", "UInt8"),
				col("clicked", "UInt8"),
			],
		),
	],
	flags: [
		table(
			"flags",
			"evaluations",
			0,
			["evaluated_at"],
			[
				col("evaluated_at", "DateTime"),
				col("flag_key", "LowCardinality(String)"),
				col("variant", "LowCardinality(String)"),
				col("user_hash", "String"),
			],
		),
	],
	crm: [
		table(
			"crm",
			"accounts",
			0,
			["created_at"],
			[
				col("id", "UInt32"),
				col("name", "String"),
				col("industry", "LowCardinality(String)"),
				col("created_at", "DateTime"),
				col("owner", "String"),
			],
		),
		table(
			"crm",
			"deals",
			0,
			["closed_at"],
			[
				col("id", "UInt32"),
				col("account_id", "UInt32"),
				col("stage", "Enum8('lead' = 1, 'qualified' = 2, 'won' = 3, 'lost' = 4)"),
				col("amount_cents", "UInt64"),
				col("closed_at", "DateTime"),
			],
		),
	],
	inventory: [
		table(
			"inventory",
			"stock_levels",
			0,
			["updated_at"],
			[
				col("sku", "String"),
				col("warehouse", "LowCardinality(String)"),
				col("quantity", "Int32"),
				col("updated_at", "DateTime"),
			],
		),
	],
	shipping: [
		table(
			"shipping",
			"shipments",
			0,
			["shipped_at"],
			[
				col("id", "UInt64"),
				col("order_id", "UInt64"),
				col("carrier", "LowCardinality(String)"),
				col("shipped_at", "DateTime"),
				col("status", "Enum8('in_transit' = 1, 'delivered' = 2, 'lost' = 3)"),
			],
		),
	],
	fraud: [
		table(
			"fraud",
			"risk_scores",
			0,
			["scored_at"],
			[
				col("scored_at", "DateTime"),
				col("payment_id", "UInt64"),
				col("score", "Float32"),
				col("decision", "Enum8('allow' = 1, 'review' = 2, 'block' = 3)"),
			],
		),
	],
	search: [
		table(
			"search",
			"queries",
			0,
			["searched_at"],
			[
				col("searched_at", "DateTime"),
				col("query", "String"),
				col("results", "UInt16"),
				col("clicked", "UInt8"),
			],
		),
	],
} satisfies Record<string, ReadonlyArray<WorldTable>>
