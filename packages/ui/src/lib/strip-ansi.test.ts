import { describe, expect, it } from "vitest"

import { stripAnsi } from "./strip-ansi"

describe("stripAnsi", () => {
	it("removes color sequences", () => {
		expect(stripAnsi("\x1b[31mERROR\x1b[0m payment failed")).toBe("ERROR payment failed")
	})

	it("removes multi-parameter and cursor sequences", () => {
		expect(stripAnsi("\x1b[1;38;5;208mwarn\x1b[39m\x1b[2K done")).toBe("warn done")
	})

	it("leaves plain text untouched", () => {
		expect(stripAnsi("plain [31m text")).toBe("plain [31m text")
	})
})
