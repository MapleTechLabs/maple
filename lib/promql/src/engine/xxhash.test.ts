import { describe, expect, it } from "vitest"
import { labelsHash, xxhash64 } from "./xxhash"

const hex = (text: string) => xxhash64(new TextEncoder().encode(text)).toString(16)

describe("xxhash64", () => {
	it("matches the reference XXH64 vectors, short and over one 32-byte stripe", () => {
		expect(hex("")).toBe("ef46db3751d8e999")
		expect(hex("a")).toBe("d24ec4f1a98c6e5b")
		expect(hex("abc")).toBe("44bc2cf5ad770999")
		expect(hex("Nobody inspects the spammish repetition")).toBe("fbcea83c8a378bf1")
	})

	it("hashes labels in name order, each string length-prefixed, as Prometheus' stringlabels does", () => {
		const bytes = new Uint8Array([1, 0x61, 1, 0x31, 1, 0x62, 1, 0x32])
		expect(labelsHash({ b: "2", a: "1" })).toBe(xxhash64(bytes))
		const long = "x".repeat(200)
		const prefixed = new Uint8Array([1, 0x6b, 200, 1, ...new TextEncoder().encode(long)])
		expect(labelsHash({ k: long })).toBe(xxhash64(prefixed))
	})
})
