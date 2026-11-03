// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// `maple.fingerprint` through the real error_events views: the user key replaces the
// computed grouping, per org and service, and the hash is the one the TS mirror derives.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { computeFingerprintInputs } from "@maple/domain/tinybird/fingerprint"
import { Schema, Array as Arr, String as Str } from "effect"
import { msToDate } from "../../platform/time"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_error_fingerprint_custom_e2e")
const ORG_ID = "org_error_fingerprint_custom"
const KEY = "checkout-payment-declined"

/** Now-relative: the tables enforce a TTL at insert time. */
const SEED_TS = Str.slice(0, 19)(Str.replace("T", " ")(msToDate(Date.now() - 60 * 60 * 1000).toISOString()))

const quote = (value: string): string => `'${Str.replace(/'/g, "\\'")(Str.replace(/\\/g, "\\\\")(value))}'`

interface Seed {
	readonly spanId: string
	readonly service: string
	readonly type: string
	readonly message: string
	readonly stacktrace: string
	readonly eventKey?: string
	readonly spanKey?: string
}

const SEEDS: ReadonlyArray<Seed> = [
	{
		spanId: "event-key",
		service: "checkout",
		type: "PaymentError",
		message: "card 4242 declined",
		stacktrace: "PaymentError: card declined\n    at charge (/app/src/pay.ts:4:2)",
		eventKey: KEY,
	},
	{
		spanId: "span-key",
		service: "checkout",
		type: "TimeoutError",
		message: "issuer did not answer",
		stacktrace:
			"TimeoutError: issuer\n    at refund (/app/src/refund.ts:9:7)\n    at handle (/app/src/h.ts:1:1)",
		spanKey: `  ${KEY}\n`,
	},
	{
		spanId: "other-service",
		service: "billing",
		type: "PaymentError",
		message: "card 4242 declined",
		stacktrace: "PaymentError: card declined\n    at charge (/app/src/pay.ts:4:2)",
		eventKey: KEY,
	},
	{
		spanId: "event-wins",
		service: "checkout",
		type: "PaymentError",
		message: "card declined",
		stacktrace: "",
		eventKey: "event-side",
		spanKey: KEY,
	},
	{
		spanId: "blank-key",
		service: "checkout",
		type: "PaymentError",
		message: "card 4242 declined",
		stacktrace: "PaymentError: card declined\n    at charge (/app/src/pay.ts:4:2)",
		eventKey: " \t ",
	},
	{
		spanId: "no-key",
		service: "checkout",
		type: "PaymentError",
		message: "card 4242 declined",
		stacktrace: "PaymentError: card declined\n    at charge (/app/src/pay.ts:4:2)",
	},
]

const keyMap = (key: string | undefined) =>
	key === undefined ? "map()" : `map('maple.fingerprint', ${quote(key)})`

const seed = async (): Promise<void> => {
	const rows = Arr.join(
		Arr.map(SEEDS, (row) => {
			const event =
				row.eventKey === undefined
					? `map('exception.type', ${quote(row.type)}, 'exception.message', ${quote(row.message)}, 'exception.stacktrace', ${quote(row.stacktrace)})`
					: `map('exception.type', ${quote(row.type)}, 'exception.message', ${quote(row.message)}, 'exception.stacktrace', ${quote(row.stacktrace)}, 'maple.fingerprint', ${quote(row.eventKey)})`
			return `(${quote(ORG_ID)}, ${quote(SEED_TS)}, ${quote(`trace-${row.spanId}`)}, ${quote(row.spanId)}, '', 'POST /pay', 'Server', ${quote(row.service)}, 1000000, 'Error', ${quote(row.message)}, ${keyMap(row.spanKey)}, map(), [toDateTime64(${quote(SEED_TS)}, 9)], ['exception'], [${event}])`
		}),
		",\n",
	)
	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes, EventsTimestamp, EventsName, EventsAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

const Row = Schema.Struct({
	SpanId: Schema.String,
	Hash: Schema.String,
	TopFrame: Schema.String,
	ErrorLabel: Schema.String,
})
type Row = typeof Row.Type
const decodeRow = Schema.decodeUnknownSync(Schema.fromJsonString(Row))

const readRows = async (sql: string): Promise<Map<string, Row>> => {
	const body = await clickhouseExec(`${sql} FORMAT JSONEachRow`, database)
	const rows = Arr.map(
		Arr.filter(Str.split("\n")(body), (line) => Str.trim(line).length > 0),
		decodeRow,
	)
	return new Map(Arr.map(rows, (row) => [row.SpanId, row]))
}

/** cityHash64 over the TS mirror's inputs, evaluated by ClickHouse itself. */
const mirroredSql = Arr.join(
	Arr.map(SEEDS, (row) => {
		const inputs = computeFingerprintInputs({
			exceptionType: row.type,
			exceptionStacktrace: row.stacktrace,
			statusMessage: row.message,
			customFingerprint: row.eventKey !== undefined && row.eventKey !== "" ? row.eventKey : row.spanKey,
		})
		return `SELECT ${quote(row.spanId)} AS SpanId, toString(cityHash64(${Arr.join(Arr.map([ORG_ID, row.service, ...inputs.hashInputs], quote), ", ")})) AS Hash, ${quote(inputs.topFrame)} AS TopFrame, ${quote(inputs.label)} AS ErrorLabel`
	}),
	"\nUNION ALL\n",
)

describe.skipIf(!clickhouseE2eEnabled)("maple.fingerprint override (ClickHouse e2e)", () => {
	let materialized: Map<string, Row>
	let mirrored: Map<string, Row>
	const hash = (spanId: string) => materialized.get(spanId)?.Hash

	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE IF NOT EXISTS ${database}`)
		await applyRealMigrations(database)
		await seed()
		materialized = await readRows(
			`SELECT SpanId, toString(FingerprintHash) AS Hash, TopFrame, ErrorLabel FROM error_events WHERE OrgId = ${quote(ORG_ID)}`,
		)
		mirrored = await readRows(mirroredSql)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	})

	it("groups different stacks and messages that carry the same key", () => {
		assert.isDefined(hash("event-key"))
		assert.strictEqual(hash("span-key"), hash("event-key"))
	})

	it("keeps the same key in another service a separate issue", () => {
		assert.notStrictEqual(hash("other-service"), hash("event-key"))
	})

	it("reads the exception event's key before the span's", () => {
		assert.notStrictEqual(hash("event-wins"), hash("event-key"))
	})

	it("falls back to the computed fingerprint when the key is blank", () => {
		assert.strictEqual(hash("blank-key"), hash("no-key"))
		assert.notStrictEqual(hash("no-key"), hash("event-key"))
	})

	for (const { spanId } of SEEDS) {
		it(`materializes ${spanId} exactly as the TS mirror does`, () => {
			assert.deepStrictEqual(materialized.get(spanId), mirrored.get(spanId))
		})
	}
})
