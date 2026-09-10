import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"

// Reuse the workspace's browser tooling; no browser dependency in the landing build.
const { chromium } = createRequire(new URL("../../web/package.json", import.meta.url))("@playwright/test")
const landing = new URL("../", import.meta.url)
const dataUrl = async (path, mime) =>
	`data:${mime};base64,${(await readFile(new URL(path, landing))).toString("base64")}`
const tokens = await readFile(new URL("../../packages/ui/src/styles/tokens.css", landing), "utf8")
const darkTokens = tokens.match(/\.dark\s*\{([^}]+)\}/)[1]
const font = await dataUrl(
	"node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
	"font/woff2",
)
const mono = await dataUrl(
	"node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
	"font/woff2",
)
const logo = await dataUrl("public/favicon.svg", "image/svg+xml")
const cards = [
	{
		file: "og-image.png",
		art: "maple-rome-balanced.webp",
		label: "OPEN-SOURCE OBSERVABILITY",
		title: "Built on<br>OpenTelemetry.<br><em>Your agent<br>reads it too.</em>",
		footer: "Traces, logs & metrics",
		url: "maple.dev",
	},
	{
		file: "og-docs.png",
		art: "features/log-management.webp",
		label: "DOCUMENTATION",
		title: "Instrument<br>your stack.<br><em>Understand<br>every signal.</em>",
		footer: "Guides · SDKs · Self-hosting",
		url: "maple.dev/docs",
	},
]

const browser = await chromium.launch()
try {
	const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
	for (const card of cards) {
		const art = await dataUrl(`public/art/${card.art}`, "image/webp")
		await page.setContent(`<!doctype html><html><head><style>
			@font-face { font-family: Geist; src: url('${font}'); font-weight: 100 900; }
			@font-face { font-family: Mono; src: url('${mono}'); font-weight: 100 900; }
			:root { ${darkTokens} }
			* { box-sizing: border-box; }
			body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: var(--background); color: var(--foreground); font-family: Geist; }
			.art { position: absolute; right: -40px; bottom: 0; width: 945px; height: 630px; object-fit: cover; }
			.shade { position: absolute; inset: 0; background: linear-gradient(90deg, var(--background) 0%, var(--background) 26%, transparent 70%), linear-gradient(0deg, var(--background), transparent 24%); }
			main { position: relative; padding: 42px 52px; height: 100%; }
			.brand { display: flex; align-items: center; gap: 10px; font-size: 30px; font-weight: 650; letter-spacing: -1px; }
			.brand img { width: 43px; height: 43px; }
			.label { margin-top: 39px; font: 14px Mono; letter-spacing: 2px; color: var(--primary); }
			h1 { margin: 18px 0 0; font-size: 66px; line-height: 1.04; letter-spacing: -.04em; font-weight: 700; }
			em { font-style: normal; color: var(--primary); }
			footer { position: absolute; bottom: 38px; left: 52px; right: 52px; display: flex; justify-content: space-between; font: 16px Mono; }
			.url { color: var(--foreground); }
		</style></head><body><img class="art" src="${art}" alt=""><div class="shade"></div><main>
			<div class="brand"><img src="${logo}" alt="">Maple</div>
			<div class="label">${card.label}</div><h1>${card.title}</h1>
			<footer><span>${card.footer}</span><span class="url">${card.url}</span></footer>
		</main></body></html>`)
		await page.evaluate(async () => {
			await document.fonts.ready
			await Promise.all(Array.from(document.images, (image) => image.decode()))
		})
		const png = await page.screenshot({ type: "png" })
		await writeFile(new URL(`public/${card.file}`, landing), png)
		// The application has the same generic social preview as the marketing site.
		if (card.file === "og-image.png") {
			await writeFile(new URL("../web/public/og-image.png", landing), png)
		}
		console.log(`Generated ${card.file} (1200 × 630)`)
	}
} finally {
	await browser.close()
}
