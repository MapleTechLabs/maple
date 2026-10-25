// Ordered-dither art for the React-to-Foldkit cover: two strands (the two builds) drift
// apart on the left and converge into one band on the right. Multi-level Bayer 8x8 dither
// across the brand ground, a dim ember and amber. Writes public/blog/react-to-foldkit-dither.png.
import { writeFile } from "node:fs/promises"
import { createRequire } from "node:module"

const { chromium } = createRequire(new URL("../../../web/package.json", import.meta.url))("playwright")
const out = new URL("../../public/blog/react-to-foldkit-dither.png", import.meta.url)

const browser = await chromium.launch()
try {
	const page = await browser.newPage({ viewport: { width: 2400, height: 1260 } })
	const dataUrl = await page.evaluate(() => {
		const W = 2400,
			H = 1260,
			CELL = 4
		const canvas = document.createElement("canvas")
		canvas.width = W
		canvas.height = H
		const g = canvas.getContext("2d")
		const bayer = [
			[0, 32, 8, 40, 2, 34, 10, 42],
			[48, 16, 56, 24, 50, 18, 58, 26],
			[12, 44, 4, 36, 14, 46, 6, 38],
			[60, 28, 52, 20, 62, 30, 54, 22],
			[3, 35, 11, 43, 1, 33, 9, 41],
			[51, 19, 59, 27, 49, 17, 57, 25],
			[15, 47, 7, 39, 13, 45, 5, 37],
			[63, 31, 55, 23, 61, 29, 53, 21],
		]
		const inks = ["#1a1714", "#3b2717", "#7a4a1f", "#e8872a", "#f2c48d"]
		const smooth = (a, b, x) => {
			const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
			return t * t * (3 - 2 * t)
		}
		// Card space is 1200 x 630.
		const field = (x, y) => {
			const join = smooth(260, 1080, x)
			const sep = 150 * (1 - join)
			const drift = 38 * Math.sin(x / 190) + 18 * Math.sin(x / 83 + 1.1)
			const strand = (sign, phase) => {
				const cy = 330 + drift + sign * sep + 26 * (1 - join) * Math.sin(x / 120 + phase)
				const w = 16 + 20 * join
				return Math.exp(-(((y - cy) / w) ** 2))
			}
			const a = strand(-1, 0),
				b = strand(1, 2.2)
			const strands = Math.max(a, b) + 0.45 * a * b
			const halo = 0.32 * Math.exp(-(((y - 330 - drift) / (60 + 50 * join)) ** 2))
			const reach = 0.16 + 0.84 * smooth(560, 1050, x)
			// A faint grain everywhere so the card reads as one printed surface; the core tops out
			// below solid cream so it stays dithered.
			return 0.07 + Math.min(0.78, (strands * 0.92 + halo) * reach)
		}
		for (let cy = 0; cy < H / CELL; cy++) {
			for (let cx = 0; cx < W / CELL; cx++) {
				const v = field(((cx + 0.5) * CELL) / 2, ((cy + 0.5) * CELL) / 2)
				const level = v * (inks.length - 1)
				const base = Math.floor(level)
				const t = (bayer[cy % 8][cx % 8] + 0.5) / 64
				g.fillStyle = inks[Math.min(inks.length - 1, level - base > t ? base + 1 : base)]
				g.fillRect(cx * CELL, cy * CELL, CELL, CELL)
			}
		}
		return canvas.toDataURL("image/png")
	})
	await writeFile(out, Buffer.from(dataUrl.split(",")[1], "base64"))
	console.log("wrote", out.pathname)
} finally {
	await browser.close()
}
