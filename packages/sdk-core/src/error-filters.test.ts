import { beforeEach, describe, expect, it } from "vitest"
import { type ErrorFilter, type ErrorFilterOptions, frameUrls, makeErrorFilter } from "./error-filters"

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
let shouldCapture: ErrorFilter = makeErrorFilter()
const configureErrorFilters = (options: ErrorFilterOptions): void => {
	shouldCapture = makeErrorFilter(options)
}
/** As the SDK calls it for a thrown Error: the error is its own original. */
const check = (error: Error, frameUrl?: string): boolean =>
	shouldCapture(error, { source: "captureException", originalError: error }, frameUrl)

beforeEach(() => configureErrorFilters({}))

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

	it("reads line-only frames, async frames and ports, and skips frames with no script URL", () => {
		expect(
			frameUrls(
				[
					"    at async load (https://app.test:8443/a.js:12)",
					"    at https://app.test/b.js:3:4",
					"    at native",
					"    at f (<anonymous>)",
					"g@https://app.test/c.js:5:6",
				].join("\n"),
			),
		).toEqual(["https://app.test:8443/a.js", "https://app.test/b.js", "https://app.test/c.js"])
	})

	it("stays linear on a hostile stack line", () => {
		// The shape a backtracking pattern chokes on: many `@a://` after `at a://`.
		const line = `at a://${"@a://".repeat(50_000)}`
		const started = performance.now()
		expect(frameUrls(line)).toEqual([])
		expect(performance.now() - started).toBeLessThan(200)
	})
})

describe("makeErrorFilter", () => {
	it("drops extension errors and ResizeObserver notices by default", () => {
		const extension = errorWith(
			"boom",
			"Error: boom\n    at x (chrome-extension://abcdef/content.js:1:1)",
		)
		expect(check(extension)).toBe(false)
		expect(check(errorWith("boom"), "moz-extension://abc/script.js")).toBe(false)
		expect(check(errorWith("ResizeObserver loop limit exceeded"))).toBe(false)
		expect(check(errorWith("boom", V8_STACK))).toBe(true)
	})

	it("keeps them when the default filters are turned off", () => {
		configureErrorFilters({ defaultFilters: false })
		expect(check(errorWith("ResizeObserver loop limit exceeded"))).toBe(true)
	})

	it("drops errors whose Name: message matches ignore", () => {
		configureErrorFilters({ ignore: ["ChunkLoadError", /^AbortError: /] })
		expect(check(errorWith("Loading chunk 7 failed", undefined, "ChunkLoadError"))).toBe(false)
		expect(check(errorWith("aborted", undefined, "AbortError"))).toBe(false)
		expect(check(errorWith("aborted"))).toBe(true)
	})

	it("judges URL lists only on frames the page's own error carries", () => {
		configureErrorFilters({ allowUrls: [/^https:\/\/app\.test\//] })
		// A string rejection wrapped in an Error: its stack is this SDK's, not the page's.
		const wrapped = errorWith(
			"rejected",
			"Error: rejected\n    at asError (https://cdn.test/maple.js:1:1)",
		)
		expect(shouldCapture(wrapped, { source: "unhandledrejection", originalError: "rejected" })).toBe(true)
		// window.onerror's filename is the frame when no Error was thrown.
		expect(
			shouldCapture(
				wrapped,
				{ source: "window.onerror", originalError: wrapped },
				"https://other.test/x.js",
			),
		).toBe(false)
	})

	it("drops every matching error with a global regex, not every other one", () => {
		configureErrorFilters({ ignore: [/chunk/gi] })
		expect([1, 2, 3].map(() => check(errorWith("Loading chunk failed")))).toEqual([false, false, false])
	})

	it("matches allowUrls and denyUrls against the top frame only", () => {
		configureErrorFilters({ denyUrls: ["cdn.test"] })
		expect(check(errorWith("x", V8_STACK))).toBe(true)
		configureErrorFilters({ allowUrls: [/^https:\/\/app\.test\//] })
		expect(check(errorWith("x", V8_STACK))).toBe(true)
		expect(check(errorWith("x", "Error: x\n    at f (https://widget.test/w.js:1:1)"))).toBe(false)
		expect(check(errorWith("no frames"))).toBe(true)
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
		expect(check(errorWith("keep me"))).toBe(true)
	})
})
