import { clearSessionSink, resetConsentForTests, setConsent } from "@maple/browser-session"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startClientSession } from "./replay-loader.js"

const PENDING_KEY = "maple.replay.pending"

afterEach(() => {
	setConsent(false)
	resetConsentForTests()
	clearSessionSink()
	vi.unstubAllGlobals()
})

describe("startClientSession consent", () => {
	it("keeps the stored replay chunk on a page that starts without consent and discards it on a revoke", async () => {
		// What the previous page's recorder left for this one to send.
		const store = new Map([[PENDING_KEY, "{}"]])
		vi.stubGlobal(
			"window",
			Object.assign(new EventTarget(), {
				sessionStorage: {
					getItem: (key: string) => store.get(key) ?? null,
					setItem: (key: string, value: string) => void store.set(key, value),
					removeItem: (key: string) => void store.delete(key),
				},
				location: { href: "https://app.example.com/" },
			}),
		)
		vi.stubGlobal(
			"document",
			Object.assign(new EventTarget(), { cookie: "", visibilityState: "visible" }),
		)
		vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }))

		const session = startClientSession({
			endpoint: "https://collector.test",
			serviceName: "unit-test",
			replay: { enabled: false },
			emitSessionMeta: false,
			privacy: { requireConsent: true },
		})
		expect(store.has(PENDING_KEY)).toBe(true)

		setConsent(true)
		expect(store.has(PENDING_KEY)).toBe(true)
		setConsent(false)
		expect(store.has(PENDING_KEY)).toBe(false)
		await session.stop()
	})
})
