import { describe, expect, it } from "vitest"
import { isBrowserNoise } from "./error-noise.js"

const withStack = (message: string, stack: string): Error => {
	const error = new Error(message)
	error.stack = stack
	return error
}

describe("isBrowserNoise", () => {
	it("drops the ResizeObserver loop notices", () => {
		expect(
			isBrowserNoise(
				new Error("ResizeObserver loop completed with undelivered notifications."),
				"window.onerror",
				"https://app.maple.dev/",
			),
		).toBe(true)
		expect(isBrowserNoise(new Error("ResizeObserver loop limit exceeded"), "window.onerror")).toBe(true)
	})

	it("drops a rejection thrown from an extension's injected script", () => {
		const metaMask = withStack(
			"Failed to connect to MetaMask",
			"i: Failed to connect to MetaMask\n    at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:12:4822)",
		)
		expect(isBrowserNoise(metaMask, "unhandledrejection")).toBe(true)
		expect(
			isBrowserNoise(withStack("x", "connect@moz-extension://abc/inpage.js:1:2"), "unhandledrejection"),
		).toBe(true)
	})

	it("drops an uncaught error whose script is an extension's", () => {
		expect(
			isBrowserNoise(
				new Error("boom"),
				"window.onerror",
				"chrome-extension://fmkadmapgofadopljbjfkapdkoienihi/build/backendManager.js",
			),
		).toBe(true)
	})

	it("keeps the app's own errors, even when an extension frame sits further down the stack", () => {
		const own = withStack(
			"Cannot read properties of undefined (reading 'toLowerCase')",
			"TypeError: Cannot read properties of undefined (reading 'toLowerCase')\n    at isOpenKey (https://app.maple.dev/assets/time-range-picker.js:1:2)\n    at chrome-extension://abc/content.js:3:4",
		)
		expect(isBrowserNoise(own, "unhandledrejection")).toBe(false)
		expect(
			isBrowserNoise(
				withStack(
					"mail a@b.co failed",
					"Error: mail a@b.co failed\n    at send (https://app.test/a.js:1:1)",
				),
				"window.onerror",
			),
		).toBe(false)
		expect(isBrowserNoise("plain rejection", "unhandledrejection")).toBe(false)
	})
})
