import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { crashDetails, crashReference } from "./view"

describe("crashReference", () => {
	test("walks nested page Messages into one path", () => {
		const message = {
			_tag: "GotPageMessage",
			message: { _tag: "StatusPageNew", message: { _tag: "ElapsedPreviewDebounce", elapsedMs: 300 } },
		}
		expect(crashReference(Option.some(message))).toBe(
			"GotPageMessage > StatusPageNew > ElapsedPreviewDebounce",
		)
	})

	test("a crash with no Message happened during the first render", () => {
		expect(crashReference(Option.none())).toBe("Initial render")
	})

	test("a value with no tag is named as unknown rather than dropped", () => {
		expect(crashReference(Option.some({ message: "boom" }))).toBe("Unknown message")
	})

	test("a self-referencing Message stops instead of looping", () => {
		const message = { _tag: "Loop", message: {} }
		message.message = message
		expect(crashReference(Option.some(message)).split(" > ")).toHaveLength(8)
	})
})

describe("crashDetails", () => {
	const time = new Date("2026-10-30T12:00:00.000Z")

	test("gives support the message, page, time and build", () => {
		expect(crashDetails("GotPageMessage > Tick", { pathname: "/traces", time, build: "1b96fab" })).toBe(
			"Message: GotPageMessage > Tick\nPage: /traces\nTime: 2026-10-30T12:00:00.000Z\nBuild: 1b96fab",
		)
	})

	test("leaves the build line out of a local build without a commit", () => {
		expect(crashDetails("Initial render", { pathname: "/", time, build: undefined })).toBe(
			"Message: Initial render\nPage: /\nTime: 2026-10-30T12:00:00.000Z",
		)
	})
})
