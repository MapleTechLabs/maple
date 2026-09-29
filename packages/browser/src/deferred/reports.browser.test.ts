import { afterEach, describe, expect, it, vi } from "vitest"
import { attachLogSink, resetLogsForTests } from "../logs"
import { startReports } from "./reports"

// The module under test emits through the eager queue; record what reaches it.
const emitted: Array<{ eventName?: string; body?: string; attributes: Record<string, unknown> }> = []

afterEach(() => {
	emitted.length = 0
	resetLogsForTests()
	vi.unstubAllGlobals()
})

const violation = (blockedURI: string) =>
	new SecurityPolicyViolationEvent("securitypolicyviolation", {
		blockedURI,
		effectiveDirective: "img-src",
		violatedDirective: "img-src",
		originalPolicy: "img-src 'self'",
		disposition: "enforce",
		documentURI: location.href,
		statusCode: 200,
		sourceFile: `${location.origin}/app.js`,
		lineNumber: 12,
		columnNumber: 4,
	})

describe("startReports", () => {
	it("reports a CSP violation once per kind as a WARN log event", () => {
		attachLogSink((record) => emitted.push(record))
		vi.stubGlobal("ReportingObserver", undefined)
		const stop = startReports({ csp: true, browserReports: false })
		document.dispatchEvent(violation("https://tracker.test/pixel.gif"))
		document.dispatchEvent(violation("https://tracker.test/pixel.gif"))
		stop()

		expect(emitted).toHaveLength(1)
		expect(emitted[0]?.eventName).toBe("maple.browser.csp_violation")
		expect(emitted[0]?.body).toBe("img-src blocked https://tracker.test/pixel.gif")
		expect(emitted[0]?.attributes["maple.csp.disposition"]).toBe("enforce")
		expect(emitted[0]?.attributes["code.line.number"]).toBe(12)
	})

	it("reports nothing when turned off", () => {
		attachLogSink((record) => emitted.push(record))
		vi.stubGlobal("ReportingObserver", undefined)
		const stop = startReports({ csp: false, browserReports: false })
		document.dispatchEvent(violation("https://tracker.test/pixel.gif"))
		stop()
		expect(emitted).toEqual([])
	})

	it("reads CSP reports through ReportingObserver where it exists", async () => {
		attachLogSink((record) => emitted.push(record))
		const stop = startReports({ csp: true, browserReports: false })
		const meta = document.createElement("meta")
		meta.httpEquiv = "Content-Security-Policy"
		meta.content = "img-src 'none'"
		document.head.append(meta)
		const img = document.createElement("img")
		img.src = "https://blocked.test/a.png"
		document.body.append(img)
		await vi.waitFor(() =>
			expect(emitted.some((record) => record.eventName === "maple.browser.csp_violation")).toBe(true),
		)
		stop()
		img.remove()
	})
})
