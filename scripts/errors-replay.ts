/**
 * Replay error events through today's fingerprint and a proposed one, and show
 * how the issue count and grouping would change. Measure a fingerprint change
 * here before it rotates every issue in production.
 *
 *   bun run errors:replay                          # the synthetic corpus
 *   bun run errors:replay -- --file sample.json    # a real sample
 *
 * A sample is JSONL, or the `{ "rows": [...] }` object the `run_sql` MCP tool
 * returns. Each row: serviceName, exceptionType, statusMessage,
 * exceptionStacktrace, and optionally count (events the row stands for),
 * customFingerprint (a `maple.fingerprint` value, read from traces) and
 * fingerprintHash (production's hash, which turns on the parity check).
 * One way to pull a week of variants from an org:
 *
 *   SELECT ServiceName AS serviceName, ExceptionType AS exceptionType,
 *          StatusMessage AS statusMessage, ExceptionStacktrace AS exceptionStacktrace,
 *          toString(FingerprintHash) AS fingerprintHash, count() AS count
 *   FROM error_events WHERE $__orgFilter AND $__timeFilter(Timestamp)
 *   GROUP BY serviceName, exceptionType, statusMessage, exceptionStacktrace, fingerprintHash
 *   ORDER BY count DESC LIMIT 3 BY fingerprintHash
 *
 * The proposal lives in `./errors-replay/candidate.ts`. Samples hold customer
 * data: keep them out of the repo.
 */
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { Schema, Array as Arr, String as Str } from "effect"

import { candidateKey, currentKey, type ReplayEvent } from "./errors-replay/candidate"

const { values } = parseArgs({
	options: {
		file: { type: "string", default: new URL("./errors-replay/corpus.jsonl", import.meta.url).pathname },
		top: { type: "string", default: "12" },
	},
})
const top = Number(values.top)

const Row = Schema.Struct({
	serviceName: Schema.String,
	exceptionType: Schema.String,
	statusMessage: Schema.String,
	exceptionStacktrace: Schema.String,
	customFingerprint: Schema.optional(Schema.String),
	count: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	fingerprintHash: Schema.optional(Schema.String),
})
type Row = Schema.Schema.Type<typeof Row>
const decodeRows = Schema.decodeUnknownSync(Schema.Array(Row))
const decodeEnvelope = Schema.decodeUnknownSync(Schema.Struct({ rows: Schema.Array(Schema.Unknown) }))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const text = Str.trim(readFileSync(values.file ?? "", "utf8"))
const raw =
	Str.startsWith("{")(text) && Str.includes('"rows"')(text)
		? decodeEnvelope(decodeJson(text)).rows
		: Arr.map(
				Arr.filter(Str.split("\n")(text), (line) => Str.trim(line) !== ""),
				(line) => decodeJson(line),
			)
const rows = decodeRows(raw)

const weight = (row: Row) => row.count ?? 1
const events = Arr.reduce(rows, 0, (sum, row) => sum + weight(row))

interface Keyed {
	readonly row: Row
	readonly current: string
	readonly candidate: string
}
const keyed: ReadonlyArray<Keyed> = Arr.map(rows, (row) => {
	const event: ReplayEvent = row
	return { row, current: currentKey(event), candidate: candidateKey(event) }
})

const distinct = (keys: Iterable<string>) => new Set(keys).size
const currentGroups = distinct(Arr.map(keyed, (k) => k.current))
const candidateGroups = distinct(Arr.map(keyed, (k) => k.candidate))
const pct = (from: number, to: number) => (from === 0 ? "0%" : `${Math.round(((from - to) / from) * 100)}%`)

console.log(`\n${rows.length} sampled variants, ${events.toLocaleString()} events (${values.file})\n`)
console.log(`  issues today      ${currentGroups}`)
console.log(`  issues proposed   ${candidateGroups}   (${pct(currentGroups, candidateGroups)} fewer)`)

// Parity: the TS mirror should group exactly as the MV hashed. A mismatch means
// the replay is not measuring production, and its numbers are not to be trusted.
const hashed = Arr.filter(keyed, (k) => k.row.fingerprintHash !== undefined)
if (hashed.length > 0) {
	const hashes = distinct(Arr.map(hashed, (k) => k.row.fingerprintHash ?? ""))
	const mirrored = distinct(Arr.map(hashed, (k) => k.current))
	console.log(
		`  production hashes ${hashes}   (TS mirror: ${mirrored}${hashes === mirrored ? ", in parity" : ", NOT in parity"})`,
	)
}

const groupBy = <K>(items: ReadonlyArray<Keyed>, key: (k: Keyed) => K) => {
	const map = new Map<K, Array<Keyed>>()
	for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item])
	return map
}

const clip = (s: string, n: number) => (s.length > n ? `${Str.slice(0, n - 1)(s)}…` : s)
const oneLine = (s: string) => Str.trim(Str.replace(/\s+/g, " ")(s))

console.log(`\nWhere the change lands (service · type: issues today -> proposed)\n`)
const byType = Arr.filter(
	Arr.map(
		[...groupBy(keyed, (k) => `${k.row.serviceName} · ${k.row.exceptionType || "(no type)"}`)],
		([label, items]) => ({
			label,
			before: distinct(Arr.map(items, (k) => k.current)),
			after: distinct(Arr.map(items, (k) => k.candidate)),
		}),
	),
	(entry) => entry.before !== entry.after,
).sort((a, b) => b.before - b.after - (a.before - a.after))
for (const entry of byType.slice(0, top)) {
	console.log(
		`  ${Str.padStart(4)(String(entry.before))} -> ${Str.padEnd(4)(String(entry.after))} ${clip(entry.label, 90)}`,
	)
}
if (byType.length === 0) console.log("  (no change)")

// The merges are where a proposal goes wrong: read the messages and ask whether
// they are really one bug.
console.log(`\nLargest merges (check these are one bug)\n`)
const merges = Arr.filter(
	Arr.map([...groupBy(keyed, (k) => k.candidate).values()], (items) => ({
		items,
		merged: distinct(Arr.map(items, (k) => k.current)),
	})),
	(entry) => entry.merged > 1,
).sort((a, b) => b.merged - a.merged)
for (const { items, merged } of merges.slice(0, top)) {
	const head = items[0].row
	console.log(`  ${merged} issues -> 1   ${head.serviceName} · ${head.exceptionType || "(no type)"}`)
	for (const message of [...new Set(Arr.map(items, (k) => oneLine(k.row.statusMessage)))].slice(0, 3)) {
		console.log(`      ${clip(message || "(empty message)", 110)}`)
	}
}
if (merges.length === 0) console.log("  (none)")

const splits = Arr.filter(
	[...groupBy(keyed, (k) => k.current).values()],
	(items) => distinct(Arr.map(items, (k) => k.candidate)) > 1,
)
console.log(`\nIssues the proposal would split: ${splits.length}`)
for (const items of splits.slice(0, top)) {
	const head = items[0].row
	console.log(
		`  ${head.serviceName} · ${head.exceptionType} -> ${distinct(Arr.map(items, (k) => k.candidate))}`,
	)
}
console.log("")
