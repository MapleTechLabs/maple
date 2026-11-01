// Session replay through the built SDK: what reaches ingest, whether a viewer
// can play it back, and that private input never leaves the page.
import type { Browser, Page } from "playwright"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { OUTPUT_DIR } from "./global-setup"
import {
	everythingSent,
	type Ingest,
	launchBrowser,
	metaRowsOf,
	openApp,
	RRWEB,
	replayChunksOf,
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
})
afterEach(async () => {
	await ingest.close()
})

const configFor = (extra: Record<string, unknown> = {}) => ({
	endpoint: ingest.url,
	ingestKey: "maple_pk_e2e",
	serviceName: "e2e-web",
	...extra,
})

const SECRETS = {
	name: "Ada Lovelace",
	password: "hunter2-very-secret",
	card: "4111111111111111",
}
/** In the page markup itself, never typed: a hidden input's value and a blocked element's text. */
const MARKUP_SECRETS = { csrf: "csrf-e2e-9f8e7d6c5b4a", blocked: "078-05-1120" }

async function fillForm(page: Page): Promise<void> {
	await page.fill("#name", SECRETS.name)
	await page.fill("#password", SECRETS.password)
	await page.fill("#card", SECRETS.card)
	await page.click("#buy")
	// The panel's padding: the click target's subtree holds the blocked element.
	await page.click("#card-panel", { position: { x: 4, y: 4 } })
	await page.evaluate(() => {
		const item = document.createElement("li")
		item.textContent = "Order 1 confirmed"
		document.getElementById("list")?.append(item)
	})
}

const sessionIdOf = (page: Page): Promise<string> => page.evaluate(() => window.maple?.sessionId ?? "")

const shutdown = (page: Page): Promise<void> => page.evaluate(() => window.maple?.shutdown())

/** Rebuild the recording in the player page and read what a viewer would see. */
async function replay(events: ReadonlyArray<{ readonly timestamp: number }>) {
	const context = await browser.newContext()
	const player = await context.newPage()
	await player.goto(`${app.url}/player.html`)
	const seen = await player.evaluate(async (all) => {
		const doc = await window.replayToEnd(all)
		const value = (selector: string) => doc.querySelector<HTMLInputElement>(selector)?.value ?? null
		return {
			title: doc.getElementById("title")?.textContent ?? null,
			list: doc.getElementById("list")?.textContent ?? null,
			secretText: doc.getElementById("secret-text")?.textContent ?? null,
			name: value("#name"),
			password: value("#password"),
			card: value("#card"),
		}
	}, events)
	await context.close()
	return seen
}

describe("session replay", () => {
	it("uploads a recording a viewer can play back to the last change", async () => {
		const { page, pageErrors } = await openApp(browser, app.url, configFor())
		await page.waitForFunction(() => window.maple?.sessionId)
		const sessionId = await sessionIdOf(page)
		await fillForm(page)
		await shutdown(page)

		const chunks = replayChunksOf(ingest.requests)
		expect(chunks.length).toBeGreaterThan(0)
		expect(new Set(chunks.map((chunk) => chunk.sessionId))).toEqual(new Set([sessionId]))
		const seqs = chunks.map((chunk) => chunk.seq)
		expect(new Set(seqs).size).toBe(seqs.length)

		const ordered = [...chunks].sort((a, b) => a.seq - b.seq)
		expect(ordered[0]?.isCheckpoint).toBe(true)
		const firstTypes = ordered[0]?.events.map((event) => event.type) ?? []
		expect(firstTypes).toContain(RRWEB.Meta)
		expect(firstTypes).toContain(RRWEB.FullSnapshot)
		for (const chunk of chunks) expect(chunk.events.length).toBe(chunk.eventCount)

		const seen = await replay(ordered.flatMap((chunk) => chunk.events))
		expect(seen.title).toBe("Checkout page")
		expect(seen.list).toBe("Order 1 confirmed")
		expect(pageErrors).toEqual([])
	})

	it("masks every input by default, in the recording and in everything else sent", async () => {
		const { page } = await openApp(browser, app.url, configFor())
		await page.waitForFunction(() => window.maple?.sessionId)
		await fillForm(page)
		await shutdown(page)

		const sent = everythingSent(ingest.requests)
		for (const secret of [...Object.values(SECRETS), ...Object.values(MARKUP_SECRETS)]) {
			expect(sent).not.toContain(secret)
		}

		const seen = await replay(
			[...replayChunksOf(ingest.requests)]
				.sort((a, b) => a.seq - b.seq)
				.flatMap((chunk) => chunk.events),
		)
		expect(seen.name).not.toBe(SECRETS.name)
		expect(seen.name?.length).toBe(SECRETS.name.length)
	})

	it("keeps passwords and card numbers out even with input masking off", async () => {
		const { page } = await openApp(browser, app.url, configFor({ privacy: { maskAllInputs: false } }))
		await page.waitForFunction(() => window.maple?.sessionId)
		await fillForm(page)
		await shutdown(page)

		const sent = everythingSent(ingest.requests)
		expect(sent).toContain(SECRETS.name)
		for (const secret of [SECRETS.password, SECRETS.card, ...Object.values(MARKUP_SECRETS)]) {
			expect(sent).not.toContain(secret)
		}
	})

	it("masks page text everywhere with maskAllText", async () => {
		const { page } = await openApp(browser, app.url, configFor({ privacy: { maskAllText: true } }))
		await page.waitForFunction(() => window.maple?.sessionId)
		await fillForm(page)
		await shutdown(page)

		const sent = everythingSent(ingest.requests)
		expect(sent).not.toContain("4242 credits")
		expect(sent).not.toContain("Order 1 confirmed")
		const seen = await replay(
			[...replayChunksOf(ingest.requests)]
				.sort((a, b) => a.seq - b.seq)
				.flatMap((chunk) => chunk.events),
		)
		expect(seen.secretText).not.toContain("4242")
	})

	it("continues one session across pages, each page opening with a full snapshot", async () => {
		const { page, pageErrors } = await openApp(browser, app.url, configFor())
		await page.waitForFunction(() => window.maple?.sessionId)
		const first = await sessionIdOf(page)
		await page.click("#next")
		await page.waitForURL(/next\.html/)
		await page.waitForFunction(() => window.maple?.sessionId)
		expect(await sessionIdOf(page)).toBe(first)
		await page.evaluate(() => {
			const p = document.createElement("p")
			p.textContent = "Arrived on page two"
			document.body.append(p)
		})
		await shutdown(page)

		const chunks = replayChunksOf(ingest.requests).filter((chunk) => chunk.sessionId === first)
		const seqs = chunks.map((chunk) => chunk.seq)
		expect(new Set(seqs).size).toBe(seqs.length)
		const fullSnapshots = chunks
			.flatMap((chunk) => chunk.events)
			.filter((e) => e.type === RRWEB.FullSnapshot)
		expect(fullSnapshots.length).toBeGreaterThanOrEqual(2)
		// The second page's recording starts from its own snapshot, so it plays on its own.
		const secondPage = [...chunks]
			.sort((a, b) => a.seq - b.seq)
			.flatMap((chunk) => chunk.events)
			.filter((event) => event.timestamp >= (fullSnapshots.at(-1)?.timestamp ?? 0))
		const seen = await replay(secondPage)
		expect(seen.title).toBe("Second page")
		expect(pageErrors).toEqual([])
	})

	it("ends the session row when the page goes away", async () => {
		const { page } = await openApp(browser, app.url, configFor())
		await page.waitForFunction(() => window.maple?.sessionId)
		const sessionId = await sessionIdOf(page)
		await fillForm(page)
		// Leaving for another site: pagehide fires and only keepalive requests survive.
		await page.goto("about:blank")

		const rows = await waitFor("an ended meta row", () => {
			const all = metaRowsOf(ingest.requests).filter((row) => row.session_id === sessionId)
			return all.some((row) => row.status === "ended") && all
		})
		expect(rows.some((row) => row.status === "active")).toBe(true)
		// The chunk being recorded when the page went away is not lost with it.
		const chunks = await waitFor("the unload chunk", () => {
			const all = replayChunksOf(ingest.requests).filter((chunk) => chunk.sessionId === sessionId)
			return all.some((chunk) => chunk.raw.includes("Order 1 confirmed")) && all
		})
		expect(new Set(chunks.map((chunk) => chunk.seq)).size).toBe(chunks.length)
	})

	it("starts a fresh session in a new tab and keeps it on reload", async () => {
		const { page } = await openApp(browser, app.url, configFor())
		await page.waitForFunction(() => window.maple?.sessionId)
		const first = await sessionIdOf(page)
		await page.reload()
		await page.waitForFunction(() => window.maple?.sessionId)
		expect(await sessionIdOf(page)).toBe(first)

		const other = await openApp(browser, app.url, configFor())
		await other.page.waitForFunction(() => window.maple?.sessionId)
		expect(await sessionIdOf(other.page)).not.toBe(first)
	})

	it("gives a headless crawler a session row but no recording", async () => {
		const { page } = await openApp(browser, app.url, configFor(), {
			userAgent:
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
		})
		await page.waitForFunction(() => window.maple?.sessionId)
		await fillForm(page)
		await shutdown(page)

		expect(replayChunksOf(ingest.requests)).toEqual([])
		expect(metaRowsOf(ingest.requests).length).toBeGreaterThan(0)
	})

	it("records nothing at replay sample rate 0, and still writes the session row", async () => {
		const { page } = await openApp(browser, app.url, configFor({ replay: { sampleRate: 0 } }))
		await page.waitForFunction(() => window.maple?.sessionId)
		await fillForm(page)
		await shutdown(page)

		expect(replayChunksOf(ingest.requests)).toEqual([])
		expect(metaRowsOf(ingest.requests).length).toBeGreaterThan(0)
	})
})
