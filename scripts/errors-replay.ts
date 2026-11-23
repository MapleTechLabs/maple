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
 * customFingerprint (a `maple.fingerprint` value, read from traces), span
 * (`{ kind, name }` of the failing span, read from traces too: it keys an error
 * that has no message, stack or named type) and fingerprintHash (production's
 * hash, which turns on the parity check).
 * One way to pull a week of variants from an org:
 *
 *   SELECT ServiceName AS serviceName, ExceptionType AS exceptionType,
 *          if(StatusMessage = '', ExceptionMessage, StatusMessage) AS statusMessage,
 *          ExceptionStacktrace AS exceptionStacktrace,
 *          toString(FingerprintHash) AS fingerprintHash, count() AS count
 *   FROM error_events WHERE $__orgFilter AND $__timeFilter(Timestamp)
 *   GROUP BY serviceName, exceptionType, statusMessage, exceptionStacktrace, fingerprintHash
 *   ORDER BY count DESC LIMIT 3 BY fingerprintHash
 *
 * Add `OrgId AS orgId` to sample several orgs.
 *
 * Scoring against labelled pairs (`./errors-replay/labels.ts`):
 *
 *   bun run errors:replay -- --file s.jsonl --draw pairs.jsonl       # pairs to label, for today
 *   bun run errors:replay -- --file s.jsonl --changed pairs.jsonl    # pairs the proposal decides differently
 *   bun run errors:replay -- --file s.jsonl --labels labels.jsonl    # precision, recall, F1: today vs proposal
 *
 * A labels file is JSONL of `{ a, b, same }` over the variant ids a pairs file carries.
 * Label pairs blind: a rater sees two events, never which grouping put them where.
 *
 * The proposal lives in `./errors-replay/candidate.ts`. Samples, pairs and labels hold
 * customer data: keep them out of the repo.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { Schema, Array as Arr, String as Str } from "effect"

import { candidateKey, currentKey, type ReplayEvent } from "./errors-replay/candidate"
import { drawChangedPairs, drawPairs, Label, renderPair, score, variantId } from "./errors-replay/labels"

const { values } = parseArgs({
	options: {
		file: { type: "string", default: new URL("./errors-replay/corpus.jsonl", import.meta.url).pathname },
		top: { type: "string", default: "12" },
		draw: { type: "string" },
		changed: { type: "string" },
		labels: { type: "string" },
		pairs: { type: "string", default: "300" },
	},
})
const top = Number(values.top)
const pairCount = Number(values.pairs)

const Row = Schema.Struct({
	orgId: Schema.optional(Schema.String),
	serviceName: Schema.String,
	exceptionType: Schema.String,
	statusMessage: Schema.String,
	exceptionStacktrace: Schema.String,
	customFingerprint: Schema.optional(Schema.String),
	span: Schema.optional(Schema.Struct({ kind: Schema.String, name: Schema.String })),
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

// Parity: the TS mirror should group exactly as the MV hashed, hash for hash. A
// mismatch means the replay is not measuring production, and its numbers are not
// to be trusted. A sample spanning a FINGERPRINT_VERSION deploy mismatches on its
// older hashes; sample from after the deploy to check parity.
const hashed = Arr.filter(keyed, (k) => k.row.fingerprintHash !== undefined)
if (hashed.length > 0) {
	const keysPerHash = Arr.groupBy(hashed, (k) => k.row.fingerprintHash ?? "")
	const hashesPerKey = Arr.groupBy(hashed, (k) => k.current)
	const split = Arr.filter(
		Object.values(keysPerHash),
		(ks) => distinct(Arr.map(ks, (k) => k.current)) > 1,
	).length
	const merged = Arr.filter(
		Object.values(hashesPerKey),
		(ks) => distinct(Arr.map(ks, (k) => k.row.fingerprintHash ?? "")) > 1,
	).length
	const hashes = Object.keys(keysPerHash).length
	console.log(
		`  production hashes ${hashes}   (TS mirror: ${split} split, ${merged} merged${split + merged === 0 ? ", in parity" : ", NOT in parity"})`,
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

const writePairs = (
	path: string,
	pairs: ReadonlyArray<{ readonly why: string } & Parameters<typeof renderPair>[0]>,
) => {
	writeFileSync(
		path,
		Arr.join(
			Arr.map(pairs, (p) => JSON.stringify({ why: p.why, ...renderPair(p) })),
			"\n",
		) + "\n",
	)
	console.log(`Wrote ${pairs.length} pairs to ${path}`)
}
if (values.draw !== undefined) {
	writePairs(
		values.draw,
		drawPairs(rows, currentKey, { within: Math.floor(pairCount / 2), across: Math.ceil(pairCount / 2) }),
	)
}
if (values.changed !== undefined)
	writePairs(values.changed, drawChangedPairs(rows, currentKey, candidateKey, pairCount))

if (values.labels !== undefined) {
	const labels = Schema.decodeUnknownSync(Schema.Array(Label))(
		Arr.map(
			Arr.filter(Str.split("\n")(readFileSync(values.labels, "utf8")), (line) => Str.trim(line) !== ""),
			(line) => decodeJson(line),
		),
	)
	const byId = new Map(Arr.map(rows, (row): readonly [string, ReplayEvent] => [variantId(row), row]))
	const fmt = (n: number) => n.toFixed(3)
	console.log(`Against ${labels.length} labelled pairs\n`)
	console.log(`                 precision  recall   F1      false merges  false splits`)
	for (const [name, key] of [
		["today", currentKey],
		["proposed", candidateKey],
	] as const) {
		const s = score(labels, byId, key)
		console.log(
			`  ${Str.padEnd(14)(name)} ${Str.padEnd(10)(fmt(s.precision))} ${Str.padEnd(8)(fmt(s.recall))} ${Str.padEnd(7)(fmt(s.f1))} ${Str.padEnd(13)(String(s.falseMerges))} ${s.falseSplits}   (${s.labelled} pairs in this sample)`,
		)
	}
	const changedUnlabelled = drawChangedPairs(rows, currentKey, candidateKey, 1_000_000).filter((p) => {
		const a = variantId(p.a)
		const b = variantId(p.b)
		return !labels.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))
	}).length
	if (changedUnlabelled > 0) {
		console.log(
			`\n  ${changedUnlabelled} pairs the proposal decides differently are unlabelled: label them (--changed) before trusting the delta`,
		)
	}
	console.log("")
}
