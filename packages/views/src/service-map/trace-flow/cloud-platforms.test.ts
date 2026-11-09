import { describe, expect, it } from "vitest"
import { pickAttr } from "./cloud-platforms"

describe("pickAttr", () => {
	it("skips a null value from decoded attribute JSON and takes the next key", () => {
		const attrs = JSON.parse('{"db.system.name":null,"db.system":"postgresql"}')

		expect(pickAttr(attrs, "db.system.name", "db.system")).toBe("postgresql")
	})

	it("ignores inherited Object.prototype members", () => {
		expect(pickAttr({}, "constructor", "toString")).toBeNull()
	})

	it("skips blank values", () => {
		expect(pickAttr({ a: "  ", b: "x" }, "a", "b")).toBe("x")
	})
})
