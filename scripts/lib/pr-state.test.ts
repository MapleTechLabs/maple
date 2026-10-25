import { describe, expect, test } from "bun:test"
import { previewStateOf } from "./pr-state.ts"

describe("previewStateOf", () => {
	test("an open PR keeps its preview only while it carries the label", () => {
		expect(previewStateOf({ state: "open", labels: [{ name: "bug" }, { name: "preview" }] })).toBe("live")
		expect(previewStateOf({ state: "open", labels: [{ name: "preview:web" }] })).toBe("live")
		expect(previewStateOf({ state: "open", labels: [{ name: "preview:collector" }] })).toBe("retired")
		expect(previewStateOf({ state: "open", labels: [] })).toBe("retired")
	})

	test("a closed PR is retired even if the label is still on it", () => {
		expect(previewStateOf({ state: "closed", labels: [{ name: "preview" }] })).toBe("retired")
	})

	test("an unrecognised payload is unknown, so nothing is deleted", () => {
		expect(previewStateOf({})).toBe("unknown")
		expect(previewStateOf({ state: "draft", labels: [{ name: "preview" }] })).toBe("unknown")
	})
})
