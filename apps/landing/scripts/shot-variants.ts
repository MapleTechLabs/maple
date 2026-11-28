#!/usr/bin/env bun
/**
 * `bun run sync:shots`: writes narrower copies of every capture in `public/screenshots/` to
 * `public/screenshots/w/<width>/`, and the list of them that `lib/shot-sources.ts` turns into a
 * `srcset`. Plates take the copy their box needs; the lightbox still opens the full capture.
 * Copies newer than their source are kept, so a rerun only writes what changed.
 */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import {
	SHOT_VARIANTS_MANIFEST,
	SHOT_VARIANT_DIR,
	SHOT_VARIANT_WIDTHS,
} from "../src/lib/shot-variants-config"

const root = fileURLToPath(new URL("..", import.meta.url))
const shots = join(root, "public/screenshots")
const out = join(shots, SHOT_VARIANT_DIR)
/** A copy this close to the capture's own width saves too little to be worth a request. */
const MIN_SAVING = 1.15

const walk = async (dir: string): Promise<ReadonlyArray<string>> => {
	const entries = await readdir(dir, { withFileTypes: true })
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) return path === out ? Promise.resolve([]) : walk(path)
			return Promise.resolve(entry.name.endsWith(".webp") ? [path] : [])
		}),
	)
	return nested.flat()
}

const isFresh = async (target: string, sourceTime: number) =>
	stat(target).then(
		(info) => info.mtimeMs >= sourceTime,
		() => false,
	)

const variantsOf = async (source: string) => {
	const rel = relative(shots, source)
	const meta = await sharp(source).metadata()
	const width = meta.width ?? 0
	const sourceTime = (await stat(source)).mtimeMs
	const widths = SHOT_VARIANT_WIDTHS.filter((w) => width >= w * MIN_SAVING)
	let written = 0
	for (const w of widths) {
		const target = join(out, String(w), rel)
		if (await isFresh(target, sourceTime)) continue
		await mkdir(dirname(target), { recursive: true })
		await sharp(source).resize({ width: w }).webp({ quality: 82 }).toFile(target)
		written += 1
	}
	return { src: `/screenshots/${rel.split("\\").join("/")}`, width, widths, written }
}

const sources = await walk(shots)
const results = await Promise.all(sources.map(variantsOf))
const manifest = Object.fromEntries(
	results.filter((r) => r.widths.length > 0).map((r) => [r.src, { width: r.width, widths: r.widths }]),
)
const manifestPath = join(root, SHOT_VARIANTS_MANIFEST)
await mkdir(dirname(manifestPath), { recursive: true })
await writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`)
const written = results.reduce((sum, r) => sum + r.written, 0)
console.log(`shot variants: ${Object.keys(manifest).length} captures, ${written} copies written`)
