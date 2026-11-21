/**
 * Converts the three theme faces (sans, serif, mono) to the TrueType the social-preview renderer
 * reads, into `src/og-fonts/`. The Worker imports them as Data modules: it has no static assets.
 * takumi ignores woff2 without an error, hence the conversion. Committed output; rerun after a
 * font dependency changes:
 *
 *   bun run --cwd apps/status og:fonts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import decompress from "woff2-encoder/decompress"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Each face in the subsets `OG_FONT_SUBSETS` names; other scripts fall back to takumi's built-in face. */
const FACES = [
	{ font: "sans", from: "geist/files/geist" },
	{ font: "serif", from: "source-serif-4/files/source-serif-4" },
	{ font: "mono", from: "geist-mono/files/geist-mono" },
] as const
const SUBSETS = ["latin", "latin-ext", "cyrillic"] as const

const FONTS = FACES.flatMap((face) =>
	SUBSETS.map((subset) => ({
		from: `@fontsource-variable/${face.from}-${subset}-wght-normal.woff2`,
		to: `${face.font}-${subset}.ttf`,
	})),
)

for (const font of FONTS) {
	const source = readFileSync(join(root, "node_modules", font.from))
	const ttf = new Uint8Array(await decompress(source))
	const target = join(root, "src/og-fonts", font.to)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, ttf)
	console.log(`${font.to}  ${source.length} → ${ttf.length} bytes`)
}
