/// <reference types="@types/bun" />
/**
 * Rasterizes `icons/*.svg` into the PNGs the emails reference. Gmail and Outlook
 * strip `<svg>`, so email icons are hosted PNGs like the header logo, served by
 * the landing site at https://maple.dev/email/icons/<name>.png.
 *
 * The SVGs are already coloured for the dark email surface: brand marks from
 * apps/web's AI product icons, UI glyphs from Nucleo outline. Rendered at 3x the
 * 16px they display at, for high-density screens.
 *
 * Needs `rsvg-convert` (brew install librsvg). Usage: bun run --cwd packages/email icons
 */
import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE = join(PACKAGE_ROOT, "icons")
const OUT = join(PACKAGE_ROOT, "..", "..", "apps", "landing", "public", "email", "icons")
const PX = "48"

const names = (await readdir(SOURCE)).filter((file) => file.endsWith(".svg")).sort()
for (const file of names) {
	const out = join(OUT, file.replace(/\.svg$/, ".png"))
	const proc = Bun.spawnSync(["rsvg-convert", "-w", PX, "-h", PX, "-o", out, join(SOURCE, file)])
	if (proc.exitCode !== 0) {
		console.error(`✗ ${file}: ${proc.stderr.toString()}`)
		process.exit(1)
	}
	console.log(`✓ ${out}`)
}
