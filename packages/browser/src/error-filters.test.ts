import { afterEach, describe, expect, it } from "vitest"
import { configureErrorFilters, frameUrls, shouldCapture } from "./error-filters"

const V8_STACK = `TypeError: x is undefined
    at render (https://app.test/assets/index-abc.js:10:5)
    at https://cdn.test/vendor.js:1:200`
const FIREFOX_STACK = `render@https://app.test/assets/index-abc.js:10:5
@https://cdn.test/vendor.js:1:200`

const errorWith = (message: string, stack?: string, name = "Error"): Error => {
	const error = new Error(message)
	error.name = name
	error.stack = stack
	return error
}
const hint = { source: "captureException", originalError: undefined } as const

afterEach(() => configureErrorFilters(undefined))

describe("frameUrls", () => {
	it("reads frame URLs from V8 and Firefox/Safari stacks, top first", () => {
		expect(frameUrls(V8_STACK)).toEqual([
			"https://app.test/assets/index-abc.js",
			"https://cdn.test/vendor.js",
		])
		expect(frameUrls(FIREFOX_STACK)).toEqual([
			"https://app.test/assets/index-abc.js",
			"https://cdn.test/vendor.js",
		])
	})

	it("ignores a URL in the message line", () => {
		expect(
			frameUrls("Error: failed to load https://api.test/x\n    at f (https://app.test/a.js:1:1)"),
		).toEqual(["https://app.test/a.js"])
	})
})

describe("shouldCapture", () => {
	it("drops extension errors and ResizeObserver notices by default", () => {
		const extension = errorWith(
			"boom",
			"Error: boom\n    at x (chrome-extension://abcdef/content.js:1:1)",
		)
		expect(shouldCapture(extension, hint)).toBe(false)
		expect(shouldCapture(errorWith("boom"), hint, "moz-extension://abc/script.js")).toBe(false)
		expect(shouldCapture(errorWith("ResizeObserver loop limit exceeded"), hint)).toBe(false)
		expect(shouldCapture(errorWith("boom", V8_STACK), hint)).toBe(true)
	})

	it("keeps them when the default filters are turned off", () => {
		configureErrorFilters({ defaultFilters: false })
		expect(shouldCapture(errorWith("ResizeObserver loop limit exceeded"), hint)).toBe(true)
	})

	it("drops errors whose Name: message matches ignore", () => {
		configureErrorFilters({ ignore: ["ChunkLoadError", /^AbortError: /] })
		expect(shouldCapture(errorWith("Loading chunk 7 failed", undefined, "ChunkLoadError"), hint)).toBe(
			false,
		)
		expect(shouldCapture(errorWith("aborted", undefined, "AbortError"), hint)).toBe(false)
		expect(shouldCapture(errorWith("aborted"), hint)).toBe(true)
	})

	it("matches allowUrls and denyUrls against the top frame only", () => {
		configureErrorFilters({ denyUrls: ["cdn.test"] })
		expect(shouldCapture(errorWith("x", V8_STACK), hint)).toBe(true)
		configureErrorFilters({ allowUrls: [/^https:\/\/app\.test\//] })
		expect(shouldCapture(errorWith("x", V8_STACK), hint)).toBe(true)
		expect(shouldCapture(errorWith("x", "Error: x\n    at f (https://widget.test/w.js:1:1)"), hint)).toBe(
			false,
		)
		expect(shouldCapture(errorWith("no frames"), hint)).toBe(true)
	})

	it("lets beforeCapture drop an error, and keeps it when the hook throws", () => {
		const seen: unknown[] = []
		configureErrorFilters({
			beforeCapture: (error, { originalError }) => {
				seen.push(originalError)
				return error.message !== "drop me"
			},
		})
		expect(
			shouldCapture(errorWith("drop me"), { source: "unhandledrejection", originalError: "raw" }),
		).toBe(false)
		expect(seen).toEqual(["raw"])
		configureErrorFilters({
			beforeCapture: () => {
				throw new Error("hook bug")
			},
		})
		expect(shouldCapture(errorWith("keep me"), hint)).toBe(true)
	})
})
