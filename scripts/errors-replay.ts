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
 * exceptionStacktrace, and optionally count (events the row stands for) and
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
import { Schema } from "effect"

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
	count: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
	fingerprintHash: Schema.optional(Schema.String),
})
type Row = Schema.Schema.Type<typeof Row>
const decodeRows = Schema.decodeUnknownSync(Schema.Array(Row))
const decodeEnvelope = Schema.decodeUnknownSync(Schema.Struct({ rows: Schema.Array(Schema.Unknown) }))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const text = readFileSync(values.file ?? "", "utf8").trim()
const raw = text.startsWith("{") && text.includes('"rows"')
	? decodeEnvelope(decodeJson(text)).rows
	: text.split("\n").filter((line) => line.trim() !== "").map((line) => decodeJson(line))
const rows = decodeRows(raw)

const weight = (row: Row) => row.count ?? 1
const events = rows.reduce((sum, row) => sum + weight(row), 0)

interface Keyed {
	readonly row: Row
	readonly current: string
	readonly candidate: string
}
const keyed: ReadonlyArray<Keyed> = rows.map((row) => {
	const event: ReplayEvent = row
	return { row, current: currentKey(event), candidate: candidateKey(event) }
})

const distinct = (keys: Iterable<string>) => new Set(keys).size
const currentGroups = distinct(keyed.map((k) => k.current))
const candidateGroups = distinct(keyed.map((k) => k.candidate))
const pct = (from: number, to: number) => (from === 0 ? "0%" : `${Math.round(((from - to) / from) * 100)}%`)

console.log(`\n${rows.length} sampled variants, ${events.toLocaleString()} events (${values.file})\n`)
console.log(`  issues today      ${currentGroups}`)
console.log(`  issues proposed   ${candidateGroups}   (${pct(currentGroups, candidateGroups)} fewer)`)

// Parity: the TS mirror should group exactly as the MV hashed. A mismatch means
// the replay is not measuring production, and its numbers are not to be trusted.
const hashed = keyed.filter((k) => k.row.fingerprintHash !== undefined)
if (hashed.length > 0) {
	const hashes = distinct(hashed.map((k) => k.row.fingerprintHash ?? ""))
	const mirrored = distinct(hashed.map((k) => k.current))
	console.log(`  production hashes ${hashes}   (TS mirror: ${mirrored}${hashes === mirrored ? ", in parity" : ", NOT in parity"})`)
}

const groupBy = <K>(items: ReadonlyArray<Keyed>, key: (k: Keyed) => K) => {
	const map = new Map<K, Array<Keyed>>()
	for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item])
	return map
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()

console.log(`\nWhere the change lands (service · type: issues today -> proposed)\n`)
const byType = [...groupBy(keyed, (k) => `${k.row.serviceName} · ${k.row.exceptionType || "(no type)"}`)]
	.map(([label, items]) => ({
		label,
		before: distinct(items.map((k) => k.current)),
		after: distinct(items.map((k) => k.candidate)),
	}))
	.filter((entry) => entry.before !== entry.after)
	.sort((a, b) => b.before - b.after - (a.before - a.after))
for (const entry of byType.slice(0, top)) {
	console.log(`  ${String(entry.before).padStart(4)} -> ${String(entry.after).padEnd(4)} ${clip(entry.label, 90)}`)
}
if (byType.length === 0) console.log("  (no change)")

// The merges are where a proposal goes wrong: read the messages and ask whether
// they are really one bug.
console.log(`\nLargest merges (check these are one bug)\n`)
const merges = [...groupBy(keyed, (k) => k.candidate).values()]
	.map((items) => ({ items, merged: distinct(items.map((k) => k.current)) }))
	.filter((entry) => entry.merged > 1)
	.sort((a, b) => b.merged - a.merged)
for (const { items, merged } of merges.slice(0, top)) {
	const head = items[0].row
	console.log(`  ${merged} issues -> 1   ${head.serviceName} · ${head.exceptionType || "(no type)"}`)
	for (const message of [...new Set(items.map((k) => oneLine(k.row.statusMessage)))].slice(0, 3)) {
		console.log(`      ${clip(message || "(empty message)", 110)}`)
	}
}
if (merges.length === 0) console.log("  (none)")

const splits = [...groupBy(keyed, (k) => k.current).values()].filter(
	(items) => distinct(items.map((k) => k.candidate)) > 1,
)
console.log(`\nIssues the proposal would split: ${splits.length}`)
for (const items of splits.slice(0, top)) {
	const head = items[0].row
	console.log(`  ${head.serviceName} · ${head.exceptionType} -> ${distinct(items.map((k) => k.candidate))}`)
}
console.log("")
