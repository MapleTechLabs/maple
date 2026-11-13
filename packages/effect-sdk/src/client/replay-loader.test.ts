// TEST-SEAM: the replay chunk is rrweb behind a dynamic import; these tests only ask whether it was started.
import {
	clearSessionSink,
	configurePrivacy,
	getActiveSink,
	resetConsentForTests,
	scrubUrl,
	setConsent,
} from "@maple/browser-session"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startClientSession } from "./replay-loader.js"

vi.mock("./replay.js", () => ({
	startReplaySession: vi.fn(() => ({ sessionId: "replay-session", shutdown: () => Promise.resolve() })),
}))
const { startReplaySession } = await import("./replay.js")

/** A page with its own empty storage, enough DOM for the event sink to attach to. */
const stubPage = (
	userAgent = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
) => {
	const store = new Map<string, string>()
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
	vi.stubGlobal("document", Object.assign(new EventTarget(), { cookie: "", visibilityState: "visible" }))
	vi.stubGlobal("navigator", { userAgent })
	vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }))
}

const BASE = { endpoint: "https://collector.test", serviceName: "unit-test", emitSessionMeta: false }

const PENDING_KEY = "maple.replay.pending"

afterEach(() => {
	setConsent(false)
	resetConsentForTests()
	clearSessionSink()
	vi.unstubAllGlobals()
	vi.mocked(startReplaySession).mockClear()
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

describe("startClientSession replay", () => {
	it("records a person's session", async () => {
		stubPage()
		const session = startClientSession(BASE)
		await vi.waitFor(() => expect(startReplaySession).toHaveBeenCalledTimes(1))
		await session.stop()
	})

	it("gives the replay session the noise filter, for the sink it starts after a rotation", async () => {
		stubPage()
		const session = startClientSession(BASE)
		await vi.waitFor(() => expect(startReplaySession).toHaveBeenCalledTimes(1))
		const filter = vi.mocked(startReplaySession).mock.calls[0]?.[0].isErrorNoise
		expect(
			filter?.("ResizeObserver loop completed with undelivered notifications.", "window.onerror"),
		).toBe(true)
		expect(filter?.(new Error("boom"), "window.onerror", "https://app.example.com/app.js")).toBe(false)
		await session.stop()
	})

	it("records no replay for a crawler, which still gets its session events", async () => {
		stubPage("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")
		const session = startClientSession(BASE)
		// Long enough for the lazy chunk to have resolved, as it does in the test above.
		await new Promise((resolve) => setTimeout(resolve, 50))

		expect(startReplaySession).not.toHaveBeenCalled()
		expect(getActiveSink()).toBeDefined()
		await session.stop()
	})
})

describe("startClientSession session errors", () => {
	/** The fields of an `ErrorEvent` the capture reads; node has no `ErrorEvent`. */
	const uncaught = (message: string, filename = "https://app.example.com/assets/app.js"): Event =>
		Object.assign(new Event("error"), { message, filename, error: null })

	it("counts a real uncaught error and not the benign ResizeObserver notice", async () => {
		stubPage()
		const session = startClientSession({ ...BASE, replay: { enabled: false } })

		window.dispatchEvent(uncaught("ResizeObserver loop completed with undelivered notifications."))
		window.dispatchEvent(uncaught("ResizeObserver loop limit exceeded"))
		expect(getActiveSink()?.getErrorCount()).toBe(0)

		window.dispatchEvent(uncaught("Cannot read properties of undefined (reading 'id')"))
		expect(getActiveSink()?.getErrorCount()).toBe(1)
		await session.stop()
	})

	it("counts no error thrown by a browser extension's script", async () => {
		stubPage()
		const session = startClientSession({ ...BASE, replay: { enabled: false } })

		window.dispatchEvent(
			uncaught("boom", "chrome-extension://fmkadmapgofadopljbjfkapdkoienihi/build/a.js"),
		)

		expect(getActiveSink()?.getErrorCount()).toBe(0)
		await session.stop()
	})
})

describe("startClientSession privacy", () => {
	it("removes its sanitizeUrl when stopped, so a remount does not stack another", async () => {
		stubPage()
		const session = startClientSession({
			...BASE,
			replay: { enabled: false },
			privacy: { sanitizeUrl: (url) => `${url}#seen` },
		})
		expect(scrubUrl("https://app.example.com/")).toBe("https://app.example.com/#seen")

		await session.stop()

		expect(scrubUrl("https://app.example.com/")).toBe("https://app.example.com/")
	})

	it("stops capturing when another Maple SDK on the page turns the consent gate on", async () => {
		stubPage()
		const session = startClientSession({ ...BASE, replay: { enabled: false } })
		expect(getActiveSink()).toBeDefined()

		// `@maple-dev/browser`, initialized later with `privacy.requireConsent`.
		configurePrivacy({ requireConsent: true })
		expect(getActiveSink()).toBeUndefined()

		setConsent(true)
		expect(getActiveSink()).toBeDefined()
		await session.stop()
	})
})
