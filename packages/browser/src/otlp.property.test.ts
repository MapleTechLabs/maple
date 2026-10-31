import { OTLP_UNLOAD_TAIL_BYTES, otlpKeepaliveRoom } from "@maple/browser-session"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { flushUnloading, newestFirst, newestFirstOnExit } from "./otlp"

/** Items are byte strings; a body is their concatenation, so sizes add up exactly. */
const serializer = {
	serializeRequest: (items: string[]): Uint8Array | undefined =>
		items.length === 0 ? undefined : new TextEncoder().encode(items.join("")),
	deserializeResponse: () => undefined,
}
const size = (items: string[]): number => serializer.serializeRequest(items)?.byteLength ?? 0
const limit = (): number => Math.min(OTLP_UNLOAD_TAIL_BYTES, otlpKeepaliveRoom())

/** Unique items (by index) of 0 to ~6 KiB, so a split lands anywhere in a batch. */
const batch = fc
	.array(fc.nat(6 * 1024), { maxLength: 24 })
	.map((sizes) => sizes.map((bytes, i) => `${i};`.padEnd(bytes + `${i};`.length, "x")))

describe("newestFirst", () => {
	it("loses, duplicates and reorders nothing: the older part then the newer is the input", () => {
		fc.assert(
			fc.property(batch, (items) => {
				const parts = newestFirst(items, serializer)
				expect([...(parts[1] ?? []), ...(parts[0] ?? [])]).toEqual(items)
				expect(parts.length === 1 || parts.length === 2).toBe(true)
			}),
		)
	})

	it("puts the newest items that fit the limit first, and splits only when it must", () => {
		fc.assert(
			fc.property(batch, (items) => {
				const parts = newestFirst(items, serializer)
				const newestFits = items.length > 0 && size(items.slice(-1)) <= limit()
				const allFit = size(items) <= limit()
				if (parts.length === 2) {
					expect(size(parts[0] ?? [])).toBeLessThanOrEqual(limit())
					// As many as fit: one more of the older ones would not.
					const older = parts[1] ?? []
					expect(size([...older.slice(-1), ...(parts[0] ?? [])])).toBeGreaterThan(limit())
				} else {
					expect(allFit || !newestFits).toBe(true)
				}
			}),
		)
	})
})

describe("newestFirstOnExit", () => {
	it("reports each batch once, failed when any part failed, however the parts settle", () => {
		fc.assert(
			fc.asyncProperty(
				batch,
				fc.boolean(),
				fc.array(fc.tuple(fc.boolean(), fc.boolean()), { minLength: 2, maxLength: 2 }),
				async (items, leaving, outcomes) => {
					const exported: string[][] = []
					const settles: Array<() => void> = []
					let calls = 0
					let reported: { code: number } | undefined
					const exporter = newestFirstOnExit(
						{
							export: (part: string[], callback: (result: { code: number }) => void) => {
								const [ok, async] = outcomes[exported.length] ?? [true, false]
								exported.push(part)
								const settle = () => callback({ code: ok ? 0 : 1 })
								if (async) settles.push(settle)
								else settle()
							},
							forceFlush: () => Promise.resolve(),
							shutdown: () => Promise.resolve(),
						},
						serializer,
						0,
						() => leaving,
					)
					exporter.export(items, (result) => {
						calls += 1
						reported = result
					})
					for (const settle of settles) settle()
					await Promise.resolve()

					expect(calls).toBe(1)
					expect(exported.flat().sort()).toEqual([...items].sort())
					const failed = exported.some((_, i) => !(outcomes[i] ?? [true])[0])
					expect(reported?.code).toBe(failed ? 1 : 0)
					// Outside an exit the batch goes as one export.
					if (!leaving) expect(exported).toHaveLength(1)
				},
			),
		)
	})

	it("splits newest-first inside an unload flush", () => {
		const items = ["0;".padEnd(10 * 1024, "x"), "1;".padEnd(10 * 1024, "x")]
		const exported: string[][] = []
		const exporter = newestFirstOnExit(
			{
				export: (part: string[], callback: (result: { code: number }) => void) => {
					exported.push(part)
					callback({ code: 0 })
				},
				forceFlush: () => Promise.resolve(),
				shutdown: () => Promise.resolve(),
			},
			serializer,
		)
		flushUnloading(() => exporter.export(items, () => {}))
		expect(exported).toEqual([[items[1]], [items[0]]])
	})
})
