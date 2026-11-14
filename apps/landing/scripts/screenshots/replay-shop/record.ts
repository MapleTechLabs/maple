#!/usr/bin/env bun
/**
 * Records the session behind the `strip-session` plate: a shopper browses the
 * Acme storefront, adds a jacket to the cart and hits the failing checkout twice.
 *
 *   MAPLE_INGEST_ENDPOINT=https://<worktree>.ingest.localhost MAPLE_INGEST_KEY=maple_pk_… \
 *     bun scripts/screenshots/replay-shop/record.ts
 *
 * Run it against the local stack whose ingest files data under the demo org
 * (`MAPLE_ORG_ID_OVERRIDE`), then capture `--only strip-session`.
 */
import { chromium, type Page } from "playwright"

const endpoint = process.env.MAPLE_INGEST_ENDPOINT
const ingestKey = process.env.MAPLE_INGEST_KEY
if (!endpoint || !ingestKey) throw new Error("set MAPLE_INGEST_ENDPOINT and MAPLE_INGEST_KEY")

const here = new URL(".", import.meta.url).pathname
const build = await Bun.build({
	entrypoints: [`${here}shop.ts`],
	target: "browser",
	define: { __MAPLE__: JSON.stringify({ endpoint, ingestKey }) },
})
if (!build.success) throw new Error(build.logs.join("\n"))
const bundle = await build.outputs[0]!.text()
const html = await Bun.file(`${here}index.html`).text()

const server = Bun.serve({
	port: 4180,
	routes: {
		"/shop.js": () => new Response(bundle, { headers: { "content-type": "text/javascript" } }),
		"/api/cart": () => Response.json({ ok: true }),
		// The seeded incident: payment-svc runs out of pool connections.
		"/api/checkout": async () => {
			await Bun.sleep(1800)
			return Response.json({ error: "payment-svc returned 500" }, { status: 500 })
		},
	},
	fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
})

// A real desktop Chrome UA: the headless one is classified as a bot and hidden by default.
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"

const browser = await chromium.launch({ channel: "chrome" })
const context = await browser.newContext({
	viewport: { width: 1280, height: 800 },
	userAgent: USER_AGENT,
	ignoreHTTPSErrors: true,
	locale: "en-US",
	timezoneId: "America/New_York",
})
const page = await context.newPage()

const pause = (ms: number) => page.waitForTimeout(ms)
const glide = async (p: Page, selector: string) => {
	const box = await p.locator(selector).first().boundingBox()
	if (box) await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 })
	await pause(350)
	await p.locator(selector).first().click()
}

await page.goto(`http://localhost:${server.port}/`)
await pause(2500)
await page.mouse.wheel(0, 380)
await pause(1800)
await page.mouse.wheel(0, -380)
await pause(1200)
await glide(page, 'a[href="/product/linen-overshirt"]')
await pause(2200)
await glide(page, ".size >> nth=1")
await pause(900)
await glide(page, "#add")
await pause(1600)
await glide(page, 'a[href="/"]')
await pause(1500)
await glide(page, 'a[href="/product/trail-runner-2"]')
await pause(1800)
await glide(page, ".size >> nth=2")
await glide(page, "#add")
await pause(1400)
await glide(page, 'a[href="/cart"]')
await pause(1500)
await glide(page, "#email")
await page.keyboard.type("ada@example.com", { delay: 70 })
await glide(page, "#card")
await page.keyboard.type("4242 4242 4242 4242", { delay: 60 })
await pause(600)
await glide(page, "#pay")
await pause(4000)
await glide(page, "#pay")
await pause(4500)

// Hiding the page flushes the last replay chunk and marks the session ended.
await page.close({ runBeforeUnload: true })
await new Promise((resolve) => setTimeout(resolve, 3000))
await browser.close()
await server.stop()
console.log("recorded one session on the Acme storefront")
