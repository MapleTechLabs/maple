#!/usr/bin/env bun
/**
 * `bun run screenshots:product-analytics`: the product analytics guides' screenshots, cropped
 * from the dashboard's `/lab/product-analytics` page (fixture events, no stack or sign-in).
 * Start the lab first, from `apps/web`:
 * `VITE_MAPLE_AUTH_MODE=self_hosted VITE_API_BASE_URL=http://127.0.0.1:9 PORT=3497 bun run dev`
 */
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, type Locator, type Page } from "playwright"

const WEB = process.env.MAPLE_LAB_URL ?? "http://127.0.0.1:3497"
const OUT_DIR = new URL("../../public/screenshots/guides/", import.meta.url).pathname
/** Space kept around a crop, in CSS pixels. */
const PAD = 12

interface GuideShot {
	/** Output basename: `public/screenshots/guides/<id>.webp`. */
	readonly id: string
	/** The lab scenario: `/lab/product-analytics?state=<state>`. */
	readonly state: string
	/** Clicks that reach the framed state. */
	readonly setup?: (page: Page) => Promise<void>
	/** The crop is the smallest box around these. */
	readonly frame: (page: Page) => ReadonlyArray<Locator>
}

const panel = (page: Page, heading: string) =>
	page.locator('section[data-slot="panel"]', {
		has: page.locator('[data-slot="panel-header"]', { hasText: heading }),
	})
const title = (page: Page) => page.getByRole("heading", { name: "Product analytics" })
const stats = (page: Page) => page.locator("div.grid", { hasText: "Biggest drop" }).last()
/** The bordered card an empty state sits in, found from its headline. */
const emptyState = (page: Page, headline: string) =>
	page.getByText(headline).locator("xpath=ancestor::*[contains(@class, 'border')][1]")
const builder = (page: Page) => panel(page, "in order, each within").first()

const SHOTS: ReadonlyArray<GuideShot> = [
	{
		id: "event-tracking-01-events",
		state: "events",
		frame: (page) => [title(page), panel(page, "All events")],
	},
	{
		id: "funnel-analysis-01-suggestions",
		state: "funnels-new",
		frame: (page) => [builder(page), emptyState(page, "Pick the steps people take, in order")],
	},
	{
		id: "funnel-analysis-02-steps",
		state: "funnels",
		frame: (page) => [builder(page)],
	},
	{
		id: "funnel-analysis-03-dropoff",
		state: "funnels",
		frame: (page) => [stats(page), panel(page, "Drop-off")],
	},
	{
		id: "funnel-analysis-04-steps-table",
		state: "funnels",
		frame: (page) => [panel(page, "Steps").last()],
	},
	{
		id: "funnel-analysis-05-step-filters",
		state: "funnels-filter",
		frame: (page) => [builder(page)],
	},
	{
		id: "conversion-by-channel-01-utm-source",
		state: "funnels-breakdown",
		frame: (page) => [panel(page, "By UTM source")],
	},
	{
		id: "conversion-by-channel-02-break-down-by",
		state: "funnels-breakdown",
		setup: async (page) => {
			await page.getByLabel("Break down by").click()
			await page.getByRole("listbox").waitFor()
		},
		frame: (page) => [builder(page), panel(page, "Drop-off")],
	},
	{
		id: "user-path-analysis-01-paths",
		state: "paths",
		frame: (page) => [title(page), panel(page, "What people did after")],
	},
	{
		id: "user-path-analysis-02-next-steps",
		state: "paths",
		frame: (page) => [panel(page, "Most common next step"), panel(page, "Where sequences ended")],
	},
	{
		id: "b2b-product-analytics-01-by-plan",
		state: "funnels-by-plan",
		frame: (page) => [panel(page, "By plan")],
	},
	{
		id: "b2b-product-analytics-02-count-by",
		state: "funnels-by-plan",
		frame: (page) => [builder(page)],
	},
]

const FREEZE_CSS = `*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }`

const boxAround = async (locators: ReadonlyArray<Locator>, id: string) => {
	const boxes = await Promise.all(
		locators.map(async (locator) => {
			const box = await locator.first().boundingBox()
			if (box === null) throw new Error(`${id}: a framed element is not on the page`)
			return box
		}),
	)
	const left = Math.min(...boxes.map((box) => box.x))
	const top = Math.min(...boxes.map((box) => box.y))
	const right = Math.max(...boxes.map((box) => box.x + box.width))
	const bottom = Math.max(...boxes.map((box) => box.y + box.height))
	return { x: left - PAD, y: top - PAD, width: right - left + 2 * PAD, height: bottom - top + 2 * PAD }
}

const only = process.argv[2]?.split(",")
const browser = await chromium.launch({ channel: "chrome" })
// Tall enough that no panel sits below the fold of the page's own scroll area.
const context = await browser.newContext({
	viewport: { width: 1440, height: 2000 },
	deviceScaleFactor: 2,
	colorScheme: "dark",
	reducedMotion: "reduce",
	timezoneId: "UTC",
})
for (const shot of SHOTS) {
	if (only !== undefined && !only.includes(shot.id)) continue
	const page = await context.newPage()
	await page.goto(`${WEB}/lab/product-analytics?state=${shot.state}`, { waitUntil: "load" })
	await title(page).waitFor({ timeout: 60_000 })
	await page.addStyleTag({ content: FREEZE_CSS })
	await page.waitForTimeout(600)
	await shot.setup?.(page)
	const pngPath = join(tmpdir(), `${shot.id}.png`)
	await page.screenshot({ path: pngPath, clip: await boxAround(shot.frame(page), shot.id) })
	await page.close()
	const cwebp = spawnSync("cwebp", ["-quiet", "-q", "90", pngPath, "-o", `${OUT_DIR}${shot.id}.webp`])
	if (cwebp.status !== 0) {
		console.error(`cwebp failed for ${shot.id}: ${cwebp.stderr.toString()}`)
		process.exit(1)
	}
	console.log(`${shot.id}.webp`)
}
await browser.close()
