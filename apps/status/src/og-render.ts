/**
 * Rasterises the status card with takumi (Rust layout and raster, as wasm). Shared by the Worker,
 * which hands it the wasm module and the fonts bundled as Data modules, and the sample script,
 * which reads both from disk.
 */
import { Renderer } from "@takumi-rs/wasm"
import {
	OG_CARD_HEIGHT,
	OG_CARD_WIDTH,
	OG_FONT_SUBSETS,
	type OgFontSubset,
	ogFontName,
	type StatusOgCard,
	statusOgCardNode,
} from "@maple/status-page"
import type { StatusPageThemeFont } from "@maple/domain/status-page"
import { Array as Arr, Record as Rec } from "effect"

/** TrueType bytes per theme font and subset; takumi ignores woff2 without an error. */
export type OgFonts = Readonly<
	Record<StatusPageThemeFont, Readonly<Record<OgFontSubset, ArrayBuffer | Uint8Array>>>
>

/** The card's logo: none (draw the name), or bytes the caller loaded and checked. */
export type OgLogo =
	| { readonly _tag: "none" }
	| { readonly _tag: "fetched"; readonly src: string; readonly data: Uint8Array }

/** Instantiates takumi's wasm; how depends on the runtime. */
export type OgWasmInit = () => Promise<void>

export const makeOgRenderer = async (init: OgWasmInit, fonts: OgFonts) => {
	await init()
	const engine = new Renderer()
	await Promise.all(
		Arr.flatMap(Rec.toEntries(fonts), ([font, subsets]) =>
			Arr.map(OG_FONT_SUBSETS, (subset) =>
				engine.registerFont({ name: ogFontName(font, subset), data: subsets[subset] }),
			),
		),
	)
	return (card: StatusOgCard, logo: OgLogo): Promise<Uint8Array<ArrayBuffer>> =>
		engine.render(statusOgCardNode(card, logo._tag !== "none"), {
			width: OG_CARD_WIDTH,
			height: OG_CARD_HEIGHT,
			format: "png",
			images: logo._tag === "fetched" ? [{ src: logo.src, data: logo.data }] : [],
		})
}

export type OgRender = Awaited<ReturnType<typeof makeOgRenderer>>
