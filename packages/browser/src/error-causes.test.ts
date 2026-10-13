import { describe, expect, it } from "vitest"
import { exceptionOf } from "./error-causes"

describe("exceptionOf", () => {
	it("hands OTel the error itself when nothing is linked", () => {
		const error = new Error("top")
		expect(exceptionOf(error)).toBe(error)
	})

	it("keeps a DOMException-style code, which OTel uses as exception.type", () => {
		const error = Object.assign(new Error("gone", { cause: new Error("why") }), { code: 20 })
		expect(exceptionOf(error)).toMatchObject({ code: 20, name: "Error", message: "gone" })
	})
})
