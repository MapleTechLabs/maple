import { Array as Arr, Brand, Hash, String as Str } from "effect"

/**
 * A gradient id both renderers can resolve. The canvas painter matches `url\(#([^)]+)\)` and
 * parses anything else as a CSS colour (throwing on `GET (unmatched)`), and the SVG renderer
 * strips non `[A-Za-z0-9_-]` characters, so caller text (routes, series names) goes through here.
 */
export type GradientId = string & Brand.Brand<"GradientId">

const brand = Brand.nominal<GradientId>()

/** Joins the parts with `-`; unsafe characters become `_` plus a hash, so distinct inputs stay distinct. */
export const gradientId = (...parts: ReadonlyArray<string>): GradientId => {
	const raw = Arr.join(parts, "-")
	const safe = Str.replace(/[^A-Za-z0-9_-]+/g, "_")(raw)
	return brand(safe === raw ? raw : `${safe}-${(Hash.string(raw) >>> 0).toString(36)}`)
}

export const gradientUrl = (id: GradientId): string => `url(#${id})`
