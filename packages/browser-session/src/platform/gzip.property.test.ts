import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { gzip, gzipStored } from "./transport"

/** The platform's own inflater, independent of the code under test. */
const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> =>
	new Uint8Array(
		await new Response(
			new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip")),
		).arrayBuffer(),
	)

// Sizes around the 65535-byte stored-block boundary are where framing breaks.
const payload = fc.oneof(
	fc.uint8Array({ maxLength: 512 }),
	fc
		.integer({ min: 0, max: 2 })
		.chain((blocks) =>
			fc
				.integer({ min: -2, max: 2 })
				.map((delta) =>
					new Uint8Array(Math.max(0, blocks * 0xffff + delta)).map((_, i) => (i * 31) & 0xff),
				),
		),
)

describe("gzipStored", () => {
	it("is gzip any inflater reads back byte for byte", async () => {
		await fc.assert(
			fc.asyncProperty(payload, async (bytes) => {
				expect(await gunzip(gzipStored(bytes))).toEqual(bytes)
			}),
			{ numRuns: 20 },
		)
		// Multi-block payloads through a real inflater: slow on a loaded CI runner.
	}, 20_000)

	it("round-trips any text an rrweb chunk can hold", async () => {
		await fc.assert(
			fc.asyncProperty(fc.string({ unit: "binary" }), async (text) => {
				const encoded = new TextEncoder().encode(text)
				expect(new TextDecoder().decode(await gunzip(gzipStored(encoded)))).toBe(
					new TextDecoder().decode(encoded),
				)
			}),
		)
	})
})

describe("gzip", () => {
	it("round-trips through a standard inflater", async () => {
		await fc.assert(
			fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (bytes) => {
				expect(await gunzip(await gzip(bytes))).toEqual(bytes)
			}),
			{ numRuns: 50 },
		)
	})
})
