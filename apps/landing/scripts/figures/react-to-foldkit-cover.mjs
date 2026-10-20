// Renders the cover and social card for the React-to-Foldkit post, matching the "Foldkit Blog
// OG Card" artboard in Wonder. Run dither-field.mjs first; writes public/blog/react-to-foldkit.png.
import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"

const { chromium } = createRequire(new URL("../../../web/package.json", import.meta.url))("playwright")
const landing = new URL("../../", import.meta.url)
const dataUrl = async (path, mime) =>
	`data:${mime};base64,${(await readFile(new URL(path, landing))).toString("base64")}`

const tokens = await readFile(new URL("../../packages/ui/src/styles/tokens.css", landing), "utf8")
const darkTokens = tokens.match(/\.dark\s*\{([^}]+)\}/)[1]
const sans = await dataUrl(
	"node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
	"font/woff2",
)
const mono = await dataUrl(
	"node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
	"font/woff2",
)
const logo = await dataUrl("public/favicon.svg", "image/svg+xml")
const art = await dataUrl("public/blog/react-to-foldkit-dither.png", "image/png")

const browser = await chromium.launch()
try {
	const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 })
	await page.setContent(`<!doctype html><html><head><style>
		@font-face { font-family: Geist; src: url('${sans}'); font-weight: 100 900; }
		@font-face { font-family: Mono; src: url('${mono}'); font-weight: 100 900; }
		:root { ${darkTokens} }
		* { box-sizing: border-box; }
		body { margin: 0; width: 1200px; height: 630px; overflow: hidden; position: relative; background: var(--background); color: var(--foreground); font-family: Mono; }
		.art { position: absolute; inset: 0; width: 1200px; height: 630px; image-rendering: pixelated; }
		main { position: absolute; left: 64px; top: 0; height: 630px; width: 600px; display: flex; flex-direction: column; justify-content: center; }
		.brand { display: flex; align-items: center; gap: 10px; font: 600 26px Geist; letter-spacing: -0.03em; }
		.brand img { width: 34px; height: 34px; }
		.label { margin-top: 34px; font-size: 13px; letter-spacing: 0.18em; color: var(--primary); }
		h1 { margin: 18px 0 0; font-size: 40px; line-height: 1.1; font-weight: 600; letter-spacing: -0.03em; }
		.accent { display: block; margin-top: 10px; color: var(--primary); }
		.meta { margin-top: 44px; display: flex; gap: 28px; font-size: 14px; color: var(--muted-foreground); }
		.meta .url { color: var(--foreground); }
	</style></head><body>
		<img class="art" src="${art}" alt="">
		<main>
			<div class="brand"><img src="${logo}" alt="">Maple</div>
			<div class="label">ENGINEERING · REACT → FOLDKIT</div>
			<h1>287,000 lines of React,<br>ported in 3 days.<span class="accent">Proven pixel for pixel.</span></h1>
			<div class="meta"><span>131 routes</span><span>2,600+ variants per run</span><span class="url">maple.dev/blog</span></div>
		</main>
	</body></html>`)
	await page.evaluate(async () => {
		await document.fonts.ready
		await Promise.all(Array.from(document.images, (image) => image.decode()))
	})
	await writeFile(
		new URL("public/blog/react-to-foldkit.png", landing),
		await page.screenshot({ type: "png" }),
	)
	console.log("Generated public/blog/react-to-foldkit.png (1200 x 630 @2x)")
} finally {
	await browser.close()
}
