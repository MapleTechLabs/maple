import { afterEach, describe, expect, it } from "vitest"
import { configureErrorFilters, isErrorNoise } from "./error-filters"

// Chromium reports the notice as a message with no error object.
const RESIZE_NOTICE = "ResizeObserver loop completed with undelivered notifications."

afterEach(() => {
	configureErrorFilters(undefined)
})

describe("isErrorNoise", () => {
	it("is true for the benign ResizeObserver notice and an extension's script, false for the app's errors", () => {
		expect(isErrorNoise(RESIZE_NOTICE, "window.onerror", "https://app.example.com/")).toBe(true)
		expect(isErrorNoise(new Error("boom"), "window.onerror", "chrome-extension://abc/inpage.js")).toBe(
			true,
		)
		expect(isErrorNoise(new Error("boom"), "window.onerror", "https://app.example.com/app.js")).toBe(
			false,
		)
		expect(isErrorNoise(new Error("request failed"), "unhandledrejection")).toBe(false)
	})

	it("keeps the notice once the app turns the default filters off", () => {
		configureErrorFilters({ defaultFilters: false })

		expect(isErrorNoise(RESIZE_NOTICE, "window.onerror")).toBe(false)
	})

	it("leaves the app's own ignore list and beforeCapture to issues", () => {
		let calls = 0
		configureErrorFilters({
			ignore: ["request failed"],
			beforeCapture: () => {
				calls++
				return false
			},
		})

		expect(isErrorNoise(new Error("request failed"), "unhandledrejection")).toBe(false)
		expect(calls).toBe(0)
	})
})
