// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import {
	clearSessionSink,
	configurePrivacy,
	resetConsentForTests,
	setConsent,
	track,
} from "@maple/browser-session"
import { afterEach, describe, expect, it, vi } from "vitest"

const tracing = vi.hoisted(() => ({ setup: vi.fn(), shutdown: vi.fn(async () => {}) }))
vi.mock("./tracing", () => ({
	setupTracing: (...args: unknown[]) => {
		tracing.setup(...args)
		return tracing.shutdown
	},
	liveMapleTracer: () => undefined,
}))

// Stands in for the lazily imported rrweb chunk: the point under test is that
// `init` reaches it only through `import()`, not that rrweb records here.
const replay = vi.hoisted(() => ({ start: vi.fn(), shutdown: vi.fn(async () => {}) }))
vi.mock("@maple/browser-session/replay", () => ({
	startReplaySession: (options: unknown) => {
		replay.start(options)
		return { sessionId: "replay-session", shutdown: replay.shutdown }
	},
}))

import { resetSinkForTests } from "../../browser-session/src/events/events-sink"
import type { MapleBrowserConfig } from "./config"
import { identify, init, type MapleBrowserHandle } from "./init"

/** `init` as plain JS can call it, with no argument: the method form lets the required one stand in. */
interface PlainJsInit {
	init(config?: MapleBrowserConfig): MapleBrowserHandle
}
const plainJs: PlainJsInit = { init }

class MemoryStorage {
	private readonly values = new Map<string, string>()
	getItem(key: string): string | null {
		return this.values.get(key) ?? null
	}
	setItem(key: string, value: string): void {
		this.values.set(key, value)
	}
	removeItem(key: string): void {
		this.values.delete(key)
	}
}

afterEach(() => {
	setConsent(false)
	resetConsentForTests()
	resetSinkForTests()
	clearSessionSink()
	tracing.setup.mockClear()
	tracing.shutdown.mockClear()
	replay.start.mockClear()
	replay.shutdown.mockClear()
	vi.unstubAllGlobals()
})

const stubBrowser = (): void => {
	vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }))
	vi.stubGlobal("window", {
		sessionStorage: new MemoryStorage(),
		localStorage: new MemoryStorage(),
		location: { href: "https://app.example.com/", host: "app.example.com" },
	})
}

describe("lazy replay chunk", () => {
	it("starts the recorder once the chunk lands and shuts it down on shutdown", async () => {
		stubBrowser()
		const handle = init({
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: false },
			replay: { enabled: true, sampleRate: 1 },
		})

		// The sampling decision is synchronous; only the handle arrives late.
		expect(replay.start).not.toHaveBeenCalled()
		expect(handle.sessionId).not.toBe("")
		await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1))
		expect(handle.sessionId).toBe("replay-session")
		// The sink the replay session starts after a rotation skips the same noise.
		const { isErrorNoise: filter } = replay.start.mock.calls[0]?.[0] ?? {}
		expect(
			filter("ResizeObserver loop completed with undelivered notifications.", "window.onerror"),
		).toBe(true)
		expect(filter(new Error("boom"), "window.onerror", "https://app.example.com/app.js")).toBe(false)

		await handle.shutdown()
		expect(replay.shutdown).toHaveBeenCalledWith({ flush: true })
	})

	it("never attaches a recorder when consent is revoked before the chunk lands", async () => {
		setConsent(true)
		stubBrowser()
		const handle = init({
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: false },
			replay: { enabled: true, sampleRate: 1 },
			privacy: { requireConsent: true },
		})
		// What the previous page's recorder left for this one to send.
		window.sessionStorage.setItem("maple.replay.pending", "{}")
		setConsent(false)
		expect(window.sessionStorage.getItem("maple.replay.pending")).toBeNull()

		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(replay.start).not.toHaveBeenCalled()

		// A later grant still records — the revoke poisoned that one chunk's
		// callback, not the sampling decision.
		setConsent(true)
		await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1))
		await handle.shutdown()
	})
})

describe("browser consent lifecycle", () => {
	it("starts on grant, discards revoked buffers, and restarts with a new session", async () => {
		const posts: Array<{ url: string; body: string }> = []
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			posts.push({
				url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				body: typeof init?.body === "string" ? init.body : "",
			})
			return new Response(null, { status: 200 })
		})
		vi.stubGlobal("window", {
			sessionStorage: new MemoryStorage(),
			localStorage: new MemoryStorage(),
			location: { href: "https://app.example.com/", host: "app.example.com" },
		})

		const handle = init({
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: true },
			replay: { enabled: false },
			privacy: { requireConsent: true },
		})
		expect(handle.sessionId).toBe("")
		expect(posts).toHaveLength(0)

		setConsent(true)
		await Promise.resolve()
		const firstSessionId = handle.sessionId
		expect(firstSessionId).not.toBe("")
		expect(tracing.setup).toHaveBeenCalledTimes(1)
		track("discard-me")

		setConsent(false)
		expect(handle.sessionId).toBe("")
		setConsent(true)
		await Promise.resolve()
		expect(handle.sessionId).not.toBe(firstSessionId)
		expect(tracing.setup).toHaveBeenCalledTimes(1)
		track("keep-me")
		await handle.shutdown()

		const eventBodies = posts
			.filter((post) => post.url.endsWith("/v1/sessionEvents"))
			.map((post) => post.body)
			.join("\n")
		expect(eventBodies).not.toContain("discard-me")
		expect(eventBodies).toContain("keep-me")
		expect(tracing.shutdown).toHaveBeenCalledTimes(1)
	})
})

describe("init from a broken call site", () => {
	it("starts on defaults when called with no config at all", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		stubBrowser()

		const handle = plainJs.init()

		// A live session, not the no-op handle: only the service name is missing.
		expect(handle.sessionId).not.toBe("")
		expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("serviceName")
		await handle.shutdown()
		warn.mockRestore()
	})

	it("returns a handle that does nothing when startup throws, and a later init works", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		stubBrowser()
		tracing.setup.mockImplementationOnce(() => {
			throw new Error("tracing broke")
		})
		const config = {
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			replay: { enabled: false },
		}

		const broken = init(config)

		expect(broken.sessionId).toBe("")
		await broken.shutdown()
		expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("init() failed")

		// The failed start left nothing behind that blocks the next one.
		const handle = init(config)
		await vi.waitFor(() => expect(handle.sessionId).not.toBe(""))
		await handle.shutdown()
		warn.mockRestore()
	})
})

describe("teardown", () => {
	it("releases the SDK and stops everything even when a teardown step fails", async () => {
		stubBrowser()
		const options = {
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: true },
			replay: { sampleRate: 1 },
		}
		const first = init(options)
		await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1))
		tracing.shutdown.mockRejectedValueOnce(new Error("provider flush failed"))
		await expect(first.shutdown()).resolves.toBeUndefined()
		expect(replay.shutdown).toHaveBeenCalledWith({ flush: true })

		const second = init(options)
		expect(second).not.toBe(first)
		expect(tracing.setup).toHaveBeenCalledTimes(2)
		await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(2))
		await second.shutdown()
	})
})

describe("a consent gate turned on after init", () => {
	it("stops capture when another SDK copy requires consent, and resumes on grant", async () => {
		stubBrowser()
		const handle = init({
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: false },
			replay: { enabled: false },
		})
		expect(handle.sessionId).not.toBe("")
		// What the Effect SDK's init does with `privacy.requireConsent`.
		configurePrivacy({ requireConsent: true })
		expect(handle.sessionId).toBe("")
		setConsent(true)
		expect(handle.sessionId).not.toBe("")
		await handle.shutdown()
	})
})

describe("per-session state", () => {
	it("keeps a session's replay sampling decision across page loads", async () => {
		stubBrowser()
		const options = {
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: false },
		}
		const first = init({ ...options, replay: { sampleRate: 1 } })
		await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1))
		await first.shutdown()

		// A reload of the same session must not re-roll: a sample rate of 0
		// would otherwise drop the rest of a session that is being recorded.
		const second = init({ ...options, replay: { sampleRate: 0 } })
		await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(2))
		await second.shutdown()
	})

	it("applies an identify() made before init()", async () => {
		stubBrowser()
		identify({ id: "user_early", email: "early@example.com" })
		const handle = init({
			ingestKey: "public-key",
			serviceName: "test-web",
			endpoint: "https://collector.test",
			tracing: { enabled: false },
			replay: { sampleRate: 1 },
			user: { id: "user_from_config" },
		})
		await vi.waitFor(() => expect(replay.start).toHaveBeenCalledTimes(1))
		const [options] = replay.start.mock.calls[0] as [{ getIdentity: () => { id?: string } | undefined }]
		expect(options.getIdentity()?.id).toBe("user_early")
		await handle.shutdown()
	})
})
