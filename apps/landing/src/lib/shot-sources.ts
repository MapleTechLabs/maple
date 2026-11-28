import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Option, Schema } from "effect"
import { SHOT_VARIANTS_MANIFEST, SHOT_VARIANT_DIR } from "./shot-variants-config"

/**
 * The `srcset` and `sizes` of a capture in `public/screenshots/`, from the copies `sync:shots`
 * wrote. Build time only. Without the copies a plate keeps its one full-size `src`.
 */

const Manifest = Schema.fromJsonString(
	Schema.Record(
		Schema.String,
		Schema.Struct({ width: Schema.Number, widths: Schema.Array(Schema.Number) }),
	),
)
export type ShotManifest = typeof Manifest.Type

let manifest: ShotManifest | undefined

const load = (): ShotManifest => {
	if (manifest !== undefined) return manifest
	const path = join(process.cwd(), SHOT_VARIANTS_MANIFEST)
	manifest = existsSync(path)
		? Option.getOrElse(Schema.decodeOption(Manifest)(readFileSync(path, "utf8")), () => ({}))
		: {}
	return manifest
}

export type ShotSources = Readonly<{ srcset?: string; sizes?: string }>

/**
 * `zoom` is how many times wider than its box the image is drawn (a cropped window). Browsers that
 * size from layout (`auto`, lazy images) pick the copy for the drawn width; the rest assume the
 * widest case, so no plate ever gets a softer copy than its box needs.
 */
export const shotSourcesIn =
	(copies: ShotManifest) =>
	(src: string, zoom = 1): ShotSources => {
		const entry = copies[src]
		if (entry === undefined) return {}
		const narrower = entry.widths.map(
			(w) => `${src.replace("/screenshots/", `/screenshots/${SHOT_VARIANT_DIR}/${w}/`)} ${w}w`,
		)
		return {
			srcset: [...narrower, `${src} ${entry.width}w`].join(", "),
			sizes: `auto, ${Math.round(Math.max(1, zoom) * 100)}vw`,
		}
	}

export const shotSources = (src: string, zoom = 1): ShotSources => shotSourcesIn(load())(src, zoom)

const BARE_SHOT = /<img\b(?![^>]*\ssrcset=)([^>]*?)\ssrc="(\/screenshots\/[^"]+\.webp)"([^>]*)>/g

/**
 * Gives every capture a page writes as a bare `<img>` (guides, docs prose, changelog) its copies.
 * A plate that already has a `srcset` (a cropped window sizes its own) is left as it is.
 */
export const withShotSourcesIn =
	(copies: ShotManifest) =>
	(html: string): string =>
		html.replace(BARE_SHOT, (tag: string, before: string, src: string, after: string) => {
			const { srcset, sizes } = shotSourcesIn(copies)(src)
			return srcset === undefined || sizes === undefined
				? tag
				: `<img${before} src="${src}" srcset="${srcset}" sizes="${sizes}"${after}>`
		})

export const withShotSources = (html: string): string => withShotSourcesIn(load())(html)
