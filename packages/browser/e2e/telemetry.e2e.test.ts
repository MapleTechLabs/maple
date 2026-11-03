// Traces, errors, logs, events and consent through the built SDK, against a
// cross-origin ingest that a real customer page would talk to.
import type { Browser, Page } from "playwright"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { OUTPUT_DIR } from "./global-setup"
import {
	type Ingest,
	launchBrowser,
	logsOf,
	metaRowsOf,
	openApp,
	replayChunksOf,
	sessionEventsOf,
	spansOf,
	startApp,
	startIngest,
	waitFor,
} from "./harness"

let browser: Browser
let app: Awaited<ReturnType<typeof startApp>>
let ingest: Ingest

beforeAll(async () => {
	browser = await launchBrowser()
	app = await startApp(OUTPUT_DIR)
})
afterAll(async () => {
	await browser.close()
	await app.close()
})
beforeEach(async () => {
	ingest = await startIngest()
	app.apiRequests.length = 0
})
afterEach(async () => {
	await ingest.close()
})

const configFor = (extra: Record<string, unknown> = {}) => ({
	endpoint: ingest.url,
	ingestKey: "maple_pk_e2e",
	serviceName: "e2e-web",
	serviceVersion: "1.2.3",
	environment: "e2e",
	...extra,
})

const ready = (page: Page) => page.waitForFunction(() => window.maple?.sessionId)
const sessionIdOf = (page: Page): Promise<string> => page.evaluate(() => window.maple?.sessionId ?? "")
const shutdown = (page: Page): Promise<void> => page.evaluate(() => window.maple?.shutdown())
const spanFor = (path: string) =>
	spansOf(ingest.requests).find((span) => String(span.attributes["url.full"]).includes(path))

describe("tracing", () => {
	it("traces a fetch end to end: span, propagated context, session link", async () => {
		const { page, pageErrors } = await openApp(browser, app.url, configFor())
		await ready(page)
		const sessionId = await sessionIdOf(page)
		const status = await page.evaluate(async () => (await fetch("/api/200/orders")).status)
		expect(status).toBe(200)
		// A fetch span ends once its resource timing entry lands, then exports with the next batch.
		const span = await waitFor("the fetch span", () => spanFor("/api/200/orders"))
		await shutdown(page)
		expect(span?.attributes["http.request.method"]).toBe("GET")
		expect(span?.attributes["http.response.status_code"]).toBe(200)
		expect(span?.attributes["session.id"]).toBe(sessionId)
		expect(span?.resource).toMatchObject({
			"service.name": "e2e-web",
			"service.version": "1.2.3",
		})

		// The server saw the same trace the span reports.
		const traceparent = app.apiRequests.find((r) => r.path === "/api/200/orders")?.headers.traceparent
		expect(traceparent).toMatch(new RegExp(`^00-${span?.traceId}-[0-9a-f]{16}-0[01]$`))

		// The session row lists the trace, so the replay links to it.
		const rows = metaRowsOf(ingest.requests).filter((row) => row.session_id === sessionId)
		expect(JSON.stringify(rows)).toContain(span?.traceId)
		expect(pageErrors).toEqual([])
	})

	it("marks 4xx and 5xx responses as errors, as the spec does for client spans", async () => {
		const { page } = await openApp(browser, app.url, configFor())
		await ready(page)
		await page.evaluate(async () => {
			await fetch("/api/503/down")
			await fetch("/api/404/missing")
		})
		const failed = await waitFor("the 503 span", () => spanFor("/api/503/down"))
		const missing = await waitFor("the 404 span", () => spanFor("/api/404/missing"))
		expect(failed.status.code).toBe(2)
		expect(missing.status.code).toBe(2)
		expect(missing.kind).toBe(3)
	})

	it("does not trace its own uploads", async () => {
		const { page } = await openApp(browser, app.url, configFor())
		await ready(page)
		await page.evaluate(() => fetch("/api/200/a"))
		await waitFor("the app's fetch span", () => spanFor("/api/200/a"))
		await shutdown(page)

		const own = spansOf(ingest.requests).filter((s) =>
			String(s.attributes["url.full"]).startsWith(ingest.url),
		)
		expect(own).toEqual([])
	})
})

describe("errors", () => {
	it("exports an uncaught error as an error span with its stack, without breaking the page", async () => {
		const { page, pageErrors } = await openApp(browser, app.url, configFor())
		await ready(page)
		await page.evaluate(() => {
			setTimeout(() => {
				throw new TypeError("checkout exploded")
			})
		})
		await page.waitForTimeout(100)
		await page.evaluate(() => {
			void Promise.reject(new Error("rejected in background"))
		})
		await page.waitForTimeout(100)
		await shutdown(page)

		const spans = spansOf(ingest.requests)
		const thrown = spans.find((s) => JSON.stringify(s).includes("checkout exploded"))
		expect(thrown?.status.code).toBe(2)
		const exception = thrown?.events.find((e) => e.name === "exception")
		expect(exception?.attributes["exception.type"]).toBe("TypeError")
		expect(String(exception?.attributes["exception.stacktrace"])).toContain("checkout exploded")
		expect(JSON.stringify(spans)).toContain("rejected in background")
		// The page's own error handling still sees its errors: the SDK only observes.
		expect(pageErrors).toContain("checkout exploded")
	})

	it("keeps the buffered replay of a session sampled for errors only once an error happens", async () => {
		const config = configFor({ replay: { sampleRate: 0, onErrorSampleRate: 1 } })
		const quiet = await openApp(browser, app.url, config)
		await ready(quiet.page)
		await quiet.page.fill("#name", "no error here")
		await shutdown(quiet.page)
		expect(replayChunksOf(ingest.requests)).toEqual([])

		const failing = await openApp(browser, app.url, config)
		await ready(failing.page)
		const sessionId = await sessionIdOf(failing.page)
		await failing.page.fill("#name", "about to fail")
		await failing.page.evaluate(() => window.MapleBrowser.captureException(new Error("payment failed")))
		await shutdown(failing.page)

		const chunks = await waitFor("the triggered replay", () => {
			const all = replayChunksOf(ingest.requests).filter((chunk) => chunk.sessionId === sessionId)
			return all.length > 0 && all
		})
		expect(chunks.flatMap((chunk) => chunk.events).some((event) => event.type === 2)).toBe(true)
	})
})

describe("logs and product events", () => {
	it("exports logger records linked to the session, and track() events", async () => {
		const { page } = await openApp(browser, app.url, configFor())
		await ready(page)
		const sessionId = await sessionIdOf(page)
		await page.evaluate(() => {
			window.MapleBrowser.logger.warn("cart total mismatch", { "cart.items": 3 })
			window.MapleBrowser.track("checkout_started", { plan: "pro", seats: 5 })
		})
		await shutdown(page)

		const log = logsOf(ingest.requests).find((l) => l.body === "cart total mismatch")
		expect(log?.severityText).toBe("WARN")
		expect(log?.attributes).toMatchObject({ "cart.items": 3, "session.id": sessionId })

		const event = sessionEventsOf(ingest.requests).find((row) =>
			JSON.stringify(row).includes("checkout_started"),
		)
		expect(event?.session_id).toBe(sessionId)
	})

	it("stamps identify() on the session row", async () => {
		const { page } = await openApp(browser, app.url, configFor())
		await ready(page)
		const sessionId = await sessionIdOf(page)
		await page.evaluate(() => window.MapleBrowser.identify({ id: "user_42", email: "ada@example.com" }))
		await shutdown(page)

		const rows = metaRowsOf(ingest.requests).filter((row) => row.session_id === sessionId)
		expect(rows.at(-1)?.user_id).toBe("user_42")
	})
})

describe("consent", () => {
	it("sends nothing and stores nothing before consent, then captures once granted", async () => {
		const { page } = await openApp(browser, app.url, configFor({ privacy: { requireConsent: true } }))
		await page.fill("#name", "before consent")
		await page.evaluate(() => fetch("/api/200/early"))
		await page.waitForTimeout(500)
		expect(await sessionIdOf(page)).toBe("")
		const storage = await page.evaluate(() => ({
			local: Object.keys(localStorage),
			cookies: document.cookie,
		}))
		expect(storage.local.filter((key) => key.startsWith("maple"))).toEqual([])
		expect(storage.cookies).not.toMatch(/maple/i)
		expect(ingest.requests).toEqual([])

		await page.evaluate(() => window.MapleBrowser.setConsent(true))
		await ready(page)
		await page.evaluate(() => fetch("/api/200/after"))
		await waitFor("the consented fetch span", () => spanFor("/api/200/after"))
		await shutdown(page)
		expect(metaRowsOf(ingest.requests).length).toBeGreaterThan(0)
		expect(JSON.stringify(spansOf(ingest.requests))).not.toContain("/api/200/early")
	})

	it("stops uploading as soon as consent is revoked", async () => {
		const { page } = await openApp(browser, app.url, configFor({ privacy: { requireConsent: true } }))
		await page.evaluate(() => window.MapleBrowser.setConsent(true))
		await ready(page)
		await page.evaluate(() => window.MapleBrowser.setConsent(false))
		const sentAtRevoke = ingest.requests.length
		await page.fill("#name", "after revoke")
		await page.evaluate(() => fetch("/api/200/after-revoke"))
		await page.waitForTimeout(2_500)
		await shutdown(page)
		const after = ingest.requests.slice(sentAtRevoke)
		expect(JSON.stringify(spansOf(after))).not.toContain("after-revoke")
		expect(replayChunksOf(after).filter((chunk) => chunk.raw.includes("after revoke"))).toEqual([])
	})
})

describe("living alongside the host app", () => {
	/** What a tab switch does to the page, without a second tab. */
	const hideAndShow = (page: Page) =>
		page.evaluate(() => {
			const flip = (state: DocumentVisibilityState) => {
				Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
				document.dispatchEvent(new Event("visibilitychange"))
			}
			flip("hidden")
			flip("visible")
		})

	it("keeps a fetch wrapper the app installs after init through a tab switch", async () => {
		const { page } = await openApp(
			browser,
			app.url,
			configFor({ replay: { networkBodies: { urls: ["/api/", {}] } } }),
		)
		await ready(page)
		await page.evaluate(() => {
			const inner = window.fetch
			window.fetch = (input, init) => {
				const headers = new Headers(init?.headers)
				headers.set("x-app-auth", "wrapped")
				return inner(input, { ...init, headers })
			}
		})
		await hideAndShow(page)
		await hideAndShow(page)
		await page.evaluate(() => fetch("/api/200/after-switch"))
		const call = app.apiRequests.find((request) => request.path === "/api/200/after-switch")
		expect(call?.headers["x-app-auth"]).toBe("wrapped")
		await shutdown(page)
	})

	it("keeps the session and its replay across a tab switch", async () => {
		const { page, pageErrors } = await openApp(browser, app.url, configFor())
		await ready(page)
		const sessionId = await sessionIdOf(page)
		await hideAndShow(page)
		await page.fill("#name", "after the switch")
		expect(await sessionIdOf(page)).toBe(sessionId)
		await shutdown(page)
		const seqs = replayChunksOf(ingest.requests)
			.filter((chunk) => chunk.sessionId === sessionId)
			.map((chunk) => chunk.seq)
		expect(new Set(seqs).size).toBe(seqs.length)
		expect(pageErrors).toEqual([])
	})
})

describe("a failing ingest", () => {
	it("never surfaces in the host page, whatever ingest answers", async () => {
		for (const status of [500, 503, 429, 413, 400, 401]) {
			ingest.respond = () => status
			const { page, pageErrors } = await openApp(browser, app.url, configFor())
			await ready(page)
			await page.fill("#name", "x")
			await page.evaluate(() => fetch("/api/200/a"))
			await page.evaluate(() => window.MapleBrowser.logger.error("boom"))
			await shutdown(page)
			expect({ status, pageErrors, hostErrors: await page.evaluate(() => window.hostErrors) }).toEqual({
				status,
				pageErrors: [],
				hostErrors: [],
			})
			await page.context().close()
		}
	})

	it("survives an unreachable ingest", async () => {
		const { page, pageErrors } = await openApp(
			browser,
			app.url,
			configFor({ endpoint: "http://127.0.0.1:9" }),
		)
		await ready(page)
		await page.fill("#name", "x")
		await page.evaluate(() => fetch("/api/200/a"))
		await shutdown(page)
		expect(pageErrors).toEqual([])
		expect(await page.evaluate(() => window.hostErrors)).toEqual([])
	})
})
