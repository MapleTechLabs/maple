// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Differential fuzz of the error fingerprint: random spans go through the real
// error_events views, and every hash, top frame and label must equal what the
// TS mirror derives. The mirror is what every fingerprint unit test exercises, so
// a divergence here means those tests describe a warehouse that does not exist.
//
// Replay a failure with FINGERPRINT_FUZZ_SEED=<seed from the failure message>.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { computeFingerprintInputs, FINGERPRINT_HASH_SALT } from "@maple/domain/tinybird/fingerprint"
import { Schema } from "effect"
import fc from "fast-check"
import { msToDate } from "../../platform/time"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_error_fingerprint_fuzz_e2e")
const ORG_ID = "org_error_fingerprint_fuzz"
const SERVICE = "api"
const RUNS = 2000
const SEED = Number(process.env.FINGERPRINT_FUZZ_SEED || Date.now() % 2 ** 31)

/** Now-relative: the tables enforce a TTL at insert time. */
const SEED_TS = msToDate(Date.now() - 60 * 60 * 1000)
	.toISOString()
	.replace("T", " ")
	.slice(0, 19)

const chars = (alphabet: string, minLength: number, maxLength: number) =>
	fc.string({ unit: fc.constantFrom(...Array.from(alphabet)), minLength, maxLength })
const word = chars("abcdefghijklmnopqrstuvwxyz_", 1, 12)
const hostile = fc.oneof(
	fc.string({ unit: "grapheme", maxLength: 30 }),
	fc.string({ unit: "binary", maxLength: 20 }),
	fc.string({ maxLength: 30 }),
)

const frameLine = fc.oneof(
	fc
		.tuple(word, word, fc.nat(9999), fc.nat(999))
		.map(([fn, file, line, col]) => `    at ${fn} (/app/src/${file}.ts:${line}:${col})`),
	fc
		.tuple(word, chars("abcdefghij0123456789-", 1, 12), chars("AbCd1234_-", 8, 8), fc.nat(99))
		.map(
			([fn, host, hash, line]) =>
				`    at ${fn} (https://${host}.dev/assets/index-${hash}.js:${line}:${line})`,
		),
	fc
		.tuple(word, word, fc.nat(999))
		.map(([fn, file, line]) => `  File "/app/${file}.py", line ${line}, in ${fn}`),
	fc.tuple(word, word, fc.nat(999)).map(([fn, file, line]) => `${fn}@https://x.dev/${file}.js:${line}:1`),
	fc
		.tuple(word, fc.nat(999), chars("0123456789abcdef", 1, 6))
		.map(([file, line, pc]) => `\t/app/${file}.go:${line} +0x${pc}`),
	fc
		.tuple(fc.nat(30), word, chars("0123456789abcdef", 9, 12))
		.map(([i, binary, address]) => `${i}   ${binary}   0x${address}   +0x1d0`),
	fc.constantFrom(
		"    at http.client POST",
		"    at foo (/app/a.ts:1:2) (definition)",
		'    at [2]["params"]',
		"    at async Promise.all (index 3)",
		"    at file:///bundle/worker.js:1:2345",
		'{"user":"a@b.io","attempt":0}',
		"params: 1, abc, 2026-10-01",
		"Traceback (most recent call last):",
	),
	hostile,
)

const messagePart = fc.oneof(
	word,
	hostile,
	fc.uuid(),
	chars("0123456789abcdefABCDEF", 6, 40),
	fc.integer().map(String),
	fc.constantFrom(
		"RouteNotFound (GET /.env)",
		"RouteNotFound (POST /a/b?x=1) extra",
		"Cannot GET /wp-login.php",
		"Route GET:/x not found",
		'No route found for "GET https://x.dev/y"',
		"StatusCode error (404 GET https://host.dev/f956aa438ac39eff/codex~maple-in-process)",
		"/v1/user/@handle42",
		"rejected key tok_prod_9fQz2LmXc7RtV4bNw8Yh",
		"HTTP 503",
		"returned 418",
		"/Users/bob/.maple/store",
		"~/x",
		"'/tmp/a.log'",
		"org_2NnAbCdEfGhIjKlM",
		"01HZY3K4W7Q9N2B6C8D0E5F1GA",
		"\x1b[31mred\x1b[0m",
		"DB::Exception: Unknown identifier `x` in scope SELECT 1",
		"a@b.co",
		"https://x.y/z?q=1",
		"⟦",
		"⟧",
		"§404",
		"\u2028",
		"😀",
	),
)

/** JSON values that stress the raw re-serialization: escapes, big and exotic numbers, nesting. */
const jsonValue = fc.letrec<{ value: unknown }>((tie) => ({
	value: fc.oneof(
		{ depthSize: "small" },
		hostile,
		fc.constantFrom("\u2028\u2029", "\u000f\\u000f\\\u001f", "\u0001\t/", "é😀", 'a\\b"c'),
		fc.integer(),
		fc.double({ noNaN: true, noDefaultInfinity: true }),
		fc.boolean(),
		fc.constant(null),
		fc.array(tie("value"), { maxLength: 3 }),
		// Nested keys are re-escaped too: control characters and line separators included.
		fc.dictionary(fc.oneof(word, hostile, fc.constantFrom("k\u2028", "\u000f", "a\\b")), tie("value"), {
			maxKeys: 3,
		}),
	),
}))
const jsonMessage = fc.oneof(
	fc
		.dictionary(
			fc.oneof(
				word,
				hostile,
				fc.constantFrom("title", "message", "error", "_tag", "name", "type", "1"),
			),
			jsonValue.value,
			{
				minKeys: 1,
				maxKeys: 6,
			},
		)
		.map((object) => JSON.stringify(object, null, 0)),
	// Shapes JSON.stringify never emits: duplicate keys, raw big integers, exponent floats, spacing.
	fc
		.array(
			fc.tuple(
				fc.constantFrom('"title"', '"a"', '"1"', '"b"'),
				fc.constantFrom(
					'"x"',
					"1e21",
					"1.5E+300",
					"-0.0",
					"18446744073709551615",
					"18446744073709551616",
					'{ "b" : 1 , "1" : 2 }',
					"[ 1 , 2 ]",
					'"\\u00e9\\/"',
					'"\\ud800"',
					"1e400",
				),
			),
			{ minLength: 1, maxLength: 4 },
		)
		.map((entries) => `{ ${entries.map(([k, v]) => `${k} : ${v}`).join(" , ")} }`),
)

const Case = fc.record({
	type: fc.oneof(fc.constantFrom("", "Error", "HttpServerError", "@acme/http/errors/Upstream"), hostile),
	stack: fc.array(frameLine, { maxLength: 10 }).map((lines) => lines.join("\n")),
	message: fc.oneof(
		{ arbitrary: fc.array(messagePart, { maxLength: 40 }).map((parts) => parts.join(" ")), weight: 3 },
		{
			arbitrary: fc
				.array(messagePart, { minLength: 30, maxLength: 120 })
				.map((parts) => parts.join("")),
			weight: 1,
		},
		{ arbitrary: jsonMessage, weight: 2 },
	),
	viaAttributes: fc.boolean(),
})
type Case = typeof Case extends fc.Arbitrary<infer A> ? A : never

/** ClickHouse treats every input as UTF-8 bytes; a lone surrogate has no such encoding. */
const wellFormed = (c: Case) => c.type.isWellFormed() && c.stack.isWellFormed() && c.message.isWellFormed()
const CASES = fc.sample(Case, { numRuns: RUNS, seed: SEED }).filter(wellFormed)

/**
 * With an exception event the MV reads type and stack from it and the message from
 * StatusMessage; without one, and with no StatusMessage, it falls back to the
 * `exception.*` span attributes. Both paths feed the same mirror inputs.
 */
const traceRow = (c: Case, spanId: string) => {
	const exception = {
		"exception.type": c.type,
		"exception.message": c.message,
		"exception.stacktrace": c.stack,
	}
	return JSON.stringify({
		OrgId: ORG_ID,
		Timestamp: SEED_TS,
		TraceId: `trace-${spanId}`,
		SpanId: spanId,
		ParentSpanId: "",
		SpanName: "GET /",
		SpanKind: "Server",
		ServiceName: SERVICE,
		Duration: 1_000_000,
		StatusCode: "Error",
		StatusMessage: c.viaAttributes ? "" : c.message,
		SpanAttributes: c.viaAttributes ? exception : {},
		ResourceAttributes: {},
		EventsTimestamp: c.viaAttributes ? [] : [SEED_TS],
		EventsName: c.viaAttributes ? [] : ["exception"],
		EventsAttributes: c.viaAttributes ? [] : [exception],
	})
}

const mirrorRow = (c: Case, spanId: string) => {
	const inputs = computeFingerprintInputs({
		exceptionType: c.type,
		exceptionStacktrace: c.stack,
		statusMessage: c.message,
	})
	return JSON.stringify({
		SpanId: spanId,
		TopFrame: inputs.topFrame,
		Frames: inputs.fpFrames,
		Signature: inputs.msgSignature,
		Label: inputs.label,
		Type: c.type,
	})
}

const Mismatch = Schema.Struct({
	SpanId: Schema.String,
	TopFrame: Schema.String,
	MirrorTopFrame: Schema.String,
	ErrorLabel: Schema.String,
	MirrorLabel: Schema.String,
	HashMatches: Schema.Boolean,
	Signature: Schema.String,
})
const decodeMismatch = Schema.decodeUnknownSync(Schema.fromJsonString(Mismatch))

describe.skipIf(!clickhouseE2eEnabled)("error fingerprint differential fuzz (ClickHouse e2e)", () => {
	let materialized = 0
	let mismatches: ReadonlyArray<typeof Mismatch.Type> = []

	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE IF NOT EXISTS ${database}`)
		await applyRealMigrations(database)
		await clickhouseExec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes, EventsTimestamp, EventsName, EventsAttributes) FORMAT JSONEachRow\n${CASES.map((c, i) => traceRow(c, `case-${i}`)).join("\n")}`,
			database,
		)
		await clickhouseExec(
			"CREATE TABLE fingerprint_mirror (SpanId String, TopFrame String, Frames String, Signature String, Label String, Type String) ENGINE = Memory",
			database,
		)
		await clickhouseExec(
			`INSERT INTO fingerprint_mirror FORMAT JSONEachRow\n${CASES.map((c, i) => mirrorRow(c, `case-${i}`)).join("\n")}`,
			database,
		)
		materialized = Number(
			(
				await clickhouseExec(`SELECT count() FROM error_events WHERE OrgId = '${ORG_ID}'`, database)
			).trim(),
		)
		const body = await clickhouseExec(
			`SELECT e.SpanId AS SpanId, e.TopFrame AS TopFrame, m.TopFrame AS MirrorTopFrame,
			        e.ErrorLabel AS ErrorLabel, m.Label AS MirrorLabel, m.Signature AS Signature,
			        toBool(e.FingerprintHash = cityHash64('${ORG_ID}', '${SERVICE}', m.Type, m.Frames, m.Signature, '${FINGERPRINT_HASH_SALT}')) AS HashMatches
			 FROM error_events AS e INNER JOIN fingerprint_mirror AS m ON e.SpanId = m.SpanId
			 WHERE e.OrgId = '${ORG_ID}' AND (NOT HashMatches OR e.TopFrame != m.TopFrame OR e.ErrorLabel != m.Label)
			 FORMAT JSONEachRow`,
			database,
		)
		mismatches = body
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map(decodeMismatch)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	})

	it("materializes every case", () => {
		assert.strictEqual(materialized, CASES.length)
	})

	it("hashes, labels and picks the top frame exactly as the TS mirror does", () => {
		const shortest = [...mismatches]
			.map((m) => ({ ...m, input: CASES[Number(m.SpanId.slice("case-".length))] }))
			.sort((a, b) => JSON.stringify(a.input).length - JSON.stringify(b.input).length)
			.slice(0, 3)
		assert.deepStrictEqual(
			shortest,
			[],
			`${mismatches.length}/${CASES.length} cases diverge; replay with FINGERPRINT_FUZZ_SEED=${SEED}`,
		)
	})
})
