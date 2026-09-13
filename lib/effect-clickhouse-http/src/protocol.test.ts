import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { decodeRows } from "./protocol"
import { ClickHouseLimitError, ClickHouseProtocolError, ClickHouseServerError } from "./errors"

const encode = (s: string) => new TextEncoder().encode(s)
const info = { status: 200, queryId: "query-test", exceptionTag: "abcdefghijklmnop" }
const collect = (chunks: Uint8Array[], limits = {}) =>
	Stream.runCollect(decodeRows(Stream.fromIterable(chunks), info, limits))
const chunksAt = (bytes: Uint8Array, cut: number) => [bytes.subarray(0, cut), bytes.subarray(cut)]
const message = "Code: 395. DB::Exception: oh no 🦊. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO)\n"
const frame = `\r\n__exception__\r\n${info.exceptionTag}\r\n${message}${encode(message).length} ${info.exceptionTag}\r\n__exception__\r\n`

describe("JSONEachRow framing", () => {
	const rows = [
		{ text: "héllo 🦊 東京", quote: '\\"\n\r', n: "18446744073709551615", nested: { a: [1, null] } },
		{ ok: true },
	]
	const wire = encode(`\r\n${JSON.stringify(rows[0])}\r\n\n${JSON.stringify(rows[1])}`)
	for (let cut = 0; cut <= wire.length; cut++) {
		it.effect(`preserves UTF-8, JSON escapes and final unterminated row at byte split ${cut}`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* collect(chunksAt(wire, cut)), rows)
			}),
		)
	}
	it.effect("handles one-byte chunks and empty chunks", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(
				yield* collect([...wire].flatMap((byte) => [new Uint8Array(), Uint8Array.of(byte)])),
				rows,
			)
		}),
	)
	it.effect("handles deterministic random fragmentation across many rows", () =>
		Effect.gen(function* () {
			const expected = Array.from({ length: 300 }, (_, n) => ({ n, s: `\n🦊${n}` }))
			const bytes = encode(expected.map((r) => JSON.stringify(r)).join("\n") + "\n")
			for (let seed = 1; seed <= 30; seed++) {
				let state = seed,
					position = 0
				const chunks: Uint8Array[] = []
				while (position < bytes.length) {
					state = (Math.imul(state, 1664525) + 1013904223) >>> 0
					const size = (state % 137) + 1
					chunks.push(bytes.subarray(position, position + size))
					position += size
				}
				assert.deepStrictEqual(yield* collect(chunks), expected)
			}
		}),
	)
	for (const wire of ["", "\n\r\n \n"])
		it.effect(`accepts empty results ${JSON.stringify(wire)}`, () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* collect([encode(wire)]), [])
			}),
		)
	for (const wire of [
		'{"x":',
		'{"x":1}\n{"x":',
		"null\n",
		"[]\n",
		"42\n",
		"true\n",
		'"text"\n',
		'{"x":1} garbage\n',
		'\ufeff{"x":1}\n',
	]) {
		it.effect(`rejects malformed row ${JSON.stringify(wire)}`, () =>
			Effect.gen(function* () {
				assert.instanceOf(yield* Effect.flip(collect([encode(wire)])), ClickHouseProtocolError)
			}),
		)
	}
	for (const bytes of [
		Uint8Array.of(0xff, 10),
		Uint8Array.of(0xc3),
		Uint8Array.of(123, 34, 120, 34, 58, 34, 0xc3, 34, 125, 10),
	]) {
		it.effect(`rejects invalid UTF-8 ${bytes}`, () =>
			Effect.gen(function* () {
				assert.instanceOf(yield* Effect.flip(collect([bytes])), ClickHouseProtocolError)
			}),
		)
	}
	it.effect("does not mistake exception-looking JSON strings for server errors", () =>
		Effect.gen(function* () {
			const rows = [{ text: frame }, { text: message }]
			assert.deepStrictEqual(
				yield* collect([encode(rows.map((row) => JSON.stringify(row)).join("\n"))]),
				rows,
			)
		}),
	)
})

describe("errors after HTTP 200", () => {
	for (const [name, wire] of [
		["legacy", `{"ok":1}\n${message}`],
		["framed", `{"ok":1}\n${frame}`],
		["partial-row-framed", `{"partial":${frame}`],
	]) {
		const bytes = encode(wire!)
		for (let cut = 0; cut <= bytes.length; cut++) {
			it.effect(`${name} exception survives byte split ${cut}`, () =>
				Effect.gen(function* () {
					const error = yield* Effect.flip(collect(chunksAt(bytes, cut)))
					assert.instanceOf(error, ClickHouseServerError)
					if (error instanceof ClickHouseServerError) {
						assert.strictEqual(error.code, "395")
						assert.strictEqual(error.type, "FUNCTION_THROW_IF_VALUE_IS_NON_ZERO")
						assert.strictEqual(error.queryId, info.queryId)
						assert.include(error.message, "🦊")
					}
				}),
			)
		}
	}
	for (const [name, bad] of [
		["wrong tag", frame.replaceAll(info.exceptionTag, "wrong")],
		["wrong length", frame.replace(`${encode(message).length} `, "1 ")],
		["truncated footer", frame.slice(0, -1)],
		["missing footer", frame.slice(0, frame.lastIndexOf("__exception__"))],
		["trailing data", frame + '{"ok":1}\n'],
		["oversized exception", "__exception__\r\n" + "x".repeat(17000) + "\n"],
	])
		it.effect(`rejects ${name}`, () =>
			Effect.gen(function* () {
				assert.instanceOf(yield* Effect.flip(collect([encode(bad!)])), ClickHouseProtocolError)
			}),
		)
})

describe("bounds before row assembly", () => {
	it.effect("counts raw UTF-8 bytes, including blank lines, at exact boundaries", () =>
		Effect.gen(function* () {
			const bytes = encode('\n{"s":"🦊"}\n')
			assert.deepStrictEqual(yield* collect([bytes], { maxBytes: bytes.length }), [{ s: "🦊" }])
			const error = yield* Effect.flip(collect([bytes], { maxBytes: bytes.length - 1 }))
			assert.instanceOf(error, ClickHouseLimitError)
			if (error instanceof ClickHouseLimitError) assert.strictEqual(error.kind, "bytes")
		}),
	)
	it.effect("fails before pulling the rest of a never-terminated giant row", () =>
		Effect.gen(function* () {
			let pulled = 0
			const source = Stream.fromIterable(
				Array.from({ length: 100 }, () => encode("x".repeat(10))),
			).pipe(
				Stream.tap(() =>
					Effect.sync(() => {
						pulled++
					}),
				),
			)
			const error = yield* Effect.flip(Stream.runCollect(decodeRows(source, info, { maxBytes: 25 })))
			assert.instanceOf(error, ClickHouseLimitError)
			assert.strictEqual(pulled, 3)
		}),
	)
	it.effect("bounds individual rows across chunks and resets the count between rows", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* collect([encode("{}\n{}\n")], { maxRowBytes: 2 }), [{}, {}])
			const error = yield* Effect.flip(collect([encode('{"x"'), encode(":1}\n")], { maxRowBytes: 5 }))
			assert.instanceOf(error, ClickHouseLimitError)
			if (error instanceof ClickHouseLimitError) assert.strictEqual(error.kind, "rowBytes")
		}),
	)
	it.effect("enforces zero and exact row counts", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* collect([encode("{}\n{}\n")], { maxRows: 2 }), [{}, {}])
			assert.instanceOf(
				yield* Effect.flip(collect([encode("{}\n")], { maxRows: 0 })),
				ClickHouseLimitError,
			)
			assert.deepStrictEqual(yield* collect([], { maxRows: 0, maxBytes: 0 }), [])
		}),
	)
})

it.effect("keeps a complete framed error when the server subsequently breaks HTTP framing", () =>
	Effect.gen(function* () {
		const source = Stream.make(encode('{"ok":1}\n' + frame)).pipe(
			Stream.concat(Stream.fail("socket closed")),
		)
		const error = yield* Effect.flip(Stream.runCollect(decodeRows(source, info, {})))
		assert.instanceOf(error, ClickHouseServerError)
	}),
)
it.effect("finds the server exception following a large unfinished row", () =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(collect([encode('{"partial":"' + "x".repeat(20000) + frame)]))
		assert.instanceOf(error, ClickHouseServerError)
	}),
)
it.effect("framed exceptions survive one-byte fragmentation", () =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(collect([...encode(frame)].map((byte) => Uint8Array.of(byte))))
		assert.instanceOf(error, ClickHouseServerError)
	}),
)
