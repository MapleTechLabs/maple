#!/usr/bin/env bun
/**
 * `bun run screenshots:status-pages`: the status pages feature's plates, rendered by the
 * real public-page renderer from the demo snapshot in `src/lib/status-page-demo.ts`. No stack needed. Scripts stay off: the
 * page script would compare the fixture's clock with today's and show the delayed banner.
 */
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { demoPageHtml } from "../../src/lib/status-page-demo"
import { STATUS_PAGE_SHOTS } from "./status-page-shots"

const OUT_DIR = new URL("../../public/screenshots/", import.meta.url).pathname

const browser = await chromium.launch()
for (const capture of STATUS_PAGE_SHOTS) {
	const html = demoPageHtml(capture)
	const htmlPath = join(tmpdir(), `${capture.id}.html`)
	writeFileSync(htmlPath, html)
	const page = await browser.newPage({
		viewport: capture.viewport,
		deviceScaleFactor: capture.scale,
		javaScriptEnabled: false,
		timezoneId: "UTC",
	})
	await page.goto(`file://${htmlPath}`, { waitUntil: "load" })
	const top =
		capture.from === undefined
			? 0
			: await page
					.locator(capture.from)
					.evaluate(
						(el) =>
							(el.closest("section")?.getBoundingClientRect().top ?? 0) + window.scrollY - 24,
					)
	const pngPath = join(tmpdir(), `${capture.id}.png`)
	await page.screenshot({
		path: pngPath,
		fullPage: true,
		clip: { x: 0, y: top, width: capture.viewport.width, height: capture.viewport.height },
	})
	await page.close()
	const cwebp = spawnSync("cwebp", ["-quiet", "-q", "90", pngPath, "-o", `${OUT_DIR}${capture.id}.webp`])
	if (cwebp.status !== 0) {
		console.error(`cwebp failed for ${capture.id}: ${cwebp.stderr.toString()}`)
		process.exit(1)
	}
	console.log(`${capture.id}.webp`)
}
await browser.close()
