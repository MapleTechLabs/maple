/**
 * The social card for a docs page, rendered at build time.
 *
 * Same engine as the app's share cards (`apps/web/src/og`): takumi lays out a
 * node tree and rasterises it, here through the Node wasm build since the docs
 * are prerendered. The look follows `/og-docs.png` (made by
 * `scripts/generate-og.mjs`) so a docs link unfurls like the rest of the site,
 * with the page's own title, group and brand mark in place of the generic copy.
 */
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { container, image, text, type Node } from "@takumi-rs/helpers"
import { Renderer } from "@takumi-rs/wasm/node"
import decompress from "woff2-encoder/decompress"
import { BRAND_MARKS, markColor, type BrandMark, type BrandMarkId } from "./brand-marks"
import type { LanguageId } from "./docs-languages"

const OG_WIDTH = 1200
const OG_HEIGHT = 630

const DISPLAY_FONT = "Geist"
const MONO_FONT = "Geist Mono"

/** Dark-theme tokens from `packages/ui/src/styles/tokens.css`. */
const COLOR = {
	ground: "oklch(0.207 0.008 67)",
	ink: "oklch(0.91 0.016 74)",
	muted: "oklch(0.603 0.023 72)",
	border: "oklch(0.268 0.012 67)",
	signal: "oklch(0.714 0.154 59)",
	/** SVG fills go through a parser without `oklch()`, so the marks need hex. */
	signalHex: "#E8872A",
	inkHex: "#EAE2D6",
} as const

/** The landing app root. `import.meta.url` moves once Vite bundles this for prerendering; the build runs here. */
const landing = pathToFileURL(`${process.cwd()}/`)

/** Feature art behind each sidebar group; anything unlisted gets the generic docs art. */
const GROUP_ART = new Map([
	["AI Frameworks", "ai-mcp-integration"],
	["AI Gateways", "ai-mcp-integration"],
	["Agent Sessions", "ai-mcp-integration"],
	["Alerting", "alerts"],
	["Errors", "error-tracking"],
	["Explore", "distributed-tracing"],
	["Instrumentation", "distributed-tracing"],
	["Getting Started", "distributed-tracing"],
	["Concepts", "distributed-tracing"],
	["Dashboards", "metrics-dashboards"],
	["Infrastructure", "kubernetes-monitoring"],
	["Infrastructure as Code", "kubernetes-monitoring"],
	["Session Replay", "browser-sessions"],
	["Product Events", "browser-sessions"],
	["Integrations", "service-catalog"],
])
const DEFAULT_ART = "log-management"

/** The mark each `sdk` language shows on the card, as the sidebar's `LanguageLogo` does. */
const SDK_MARKS = {
	effect: "effect",
	node: "nodejs",
	nextjs: "nextjs",
	python: "python",
	go: "go",
	rust: "rust",
	java: "openjdk",
	kotlin: "kotlin",
	csharp: "csharp",
	laravel: "laravel",
} satisfies Record<LanguageId, BrandMarkId>

/** Same path as `packages/ui/src/components/icons/maple-mark.tsx`. */
const MAPLE_PATH =
	"M369.38 0C480.324 2.908e-08 572.686 76.542 592.669 177.775C681.438 222.749 738.763 293.878 738.765 373.942C738.763 482.538 633.316 574.71 486.96 607.449C499.978 645.591 508.455 690.397 510.789 738.765L227.967 738.764C229.399 709.074 233.146 680.725 238.834 654.436C269.538 661.732 306.949 666.785 347.396 664.859L345.194 618.741C208.102 625.268 0.005 528.243 0 373.948C2.099e-08 293.883 57.322 222.751 146.093 177.775C166.076 76.543 258.436 0.001 369.38 0ZM202.322 258.434C174.48 255.016 149.271 273.738 146.015 300.254L133.046 405.874C129.791 432.389 149.721 456.662 177.563 460.08C205.404 463.499 230.614 444.769 233.87 418.254L246.839 312.633C250.095 286.118 230.163 261.853 202.322 258.434ZM367.3 278.691C339.459 275.273 314.117 295.071 310.699 322.913L298.319 423.736C294.902 451.576 314.7 476.918 342.541 480.337C370.382 483.755 395.724 463.955 399.143 436.115L411.523 335.292C414.941 307.451 395.142 282.109 367.3 278.691Z"

const svgSrc = (svg: string): string => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`

const MAPLE_SRC = svgSrc(
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 739 739"><path fill-rule="evenodd" clip-rule="evenodd" fill="${COLOR.signalHex}" d="${MAPLE_PATH}"/></svg>`,
)

/** Multicolour marks draw their layers; near-black marks draw in ink, as on the site. */
const brandMarkSrc = (mark: BrandMark): string => {
	const color = markColor(mark) === "currentColor" ? COLOR.inkHex : mark.hex
	const paths = mark.layers
		? mark.layers.map((layer) => `<path fill="${layer.fill}" d="${layer.path}"/>`).join("")
		: `<path fill="${color}" d="${mark.path}"/>`
	const overlay = mark.overlay
		? `<path fill="${mark.overlay.fill}"${mark.overlay.fillRule ? ` fill-rule="${mark.overlay.fillRule}"` : ""} d="${mark.overlay.path}"/>`
		: ""
	return svgSrc(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox ?? "0 0 24 24"}">${paths}${overlay}</svg>`,
	)
}

interface DocsOgInput {
	readonly slug: string
	readonly title: string
	readonly description: string
	readonly group: string
	readonly sdk?: LanguageId
	readonly icon?: BrandMarkId
}

/** Headline size by length: short titles carry the thumbnail, the longest (~80 chars) must still fit three lines. */
const titleSize = (title: string): number =>
	title.length <= 22 ? 72 : title.length <= 40 ? 60 : title.length <= 60 ? 52 : 42

const artSrc = (group: string): string => `art/features/${GROUP_ART.get(group) ?? DEFAULT_ART}.webp`

const docsOgCard = (input: DocsOgInput): Node => {
	const markId = input.icon ?? (input.sdk ? SDK_MARKS[input.sdk] : undefined)
	const mark = markId ? BRAND_MARKS[markId] : undefined

	return container({
		style: {
			display: "flex",
			width: OG_WIDTH,
			height: OG_HEIGHT,
			backgroundColor: COLOR.ground,
			position: "relative",
		},
		children: [
			image({
				src: artSrc(input.group),
				style: {
					position: "absolute",
					right: -40,
					bottom: 0,
					width: 945,
					height: 630,
					objectFit: "cover",
				},
			}),
			container({
				style: {
					position: "absolute",
					inset: 0,
					backgroundImage: `linear-gradient(90deg, ${COLOR.ground} 0%, ${COLOR.ground} 46%, transparent 84%), linear-gradient(0deg, ${COLOR.ground}, transparent 24%)`,
				},
			}),
			container({
				style: {
					position: "relative",
					display: "flex",
					flexDirection: "column",
					width: "100%",
					height: "100%",
					padding: "42px 52px 38px",
				},
				children: [
					container({
						style: { display: "flex", alignItems: "center", gap: 12 },
						children: [
							image({ src: MAPLE_SRC, width: 38, height: 38 }),
							text("Maple", {
								color: COLOR.ink,
								fontSize: 30,
								fontFamily: DISPLAY_FONT,
								fontWeight: 650,
								letterSpacing: -1,
							}),
						],
					}),
					container({
						style: {
							display: "flex",
							flexDirection: "column",
							justifyContent: "center",
							flexGrow: 1,
							width: 660,
							gap: 20,
						},
						children: [
							container({
								style: { display: "flex", alignItems: "center", gap: 14 },
								children: [
									...(mark
										? [
												container({
													style: {
														display: "flex",
														alignItems: "center",
														justifyContent: "center",
														width: 44,
														height: 44,
														borderRadius: 10,
														border: `1px solid ${COLOR.border}`,
														backgroundColor: "oklch(0.235 0.01 67)",
													},
													children: [
														image({
															src: brandMarkSrc(mark),
															width: 24,
															height: 24,
														}),
													],
												}),
											]
										: []),
									text(`DOCS · ${input.group.toUpperCase()}`, {
										color: COLOR.signal,
										fontSize: 16,
										fontFamily: MONO_FONT,
										letterSpacing: 2,
									}),
								],
							}),
							text(input.title, {
								color: COLOR.ink,
								fontSize: titleSize(input.title),
								fontFamily: DISPLAY_FONT,
								fontWeight: 700,
								lineHeight: 1.06,
								letterSpacing: "-0.035em",
								lineClamp: 3,
								textOverflow: "ellipsis",
							}),
							text(input.description, {
								color: COLOR.muted,
								fontSize: 25,
								fontFamily: DISPLAY_FONT,
								lineHeight: 1.4,
								lineClamp: 2,
								textOverflow: "ellipsis",
							}),
						],
					}),
					container({
						style: { display: "flex", justifyContent: "space-between" },
						children: [
							text("Documentation", {
								color: COLOR.muted,
								fontSize: 16,
								fontFamily: MONO_FONT,
							}),
							text(`maple.dev/docs/${input.slug}`, {
								color: COLOR.ink,
								fontSize: 16,
								fontFamily: MONO_FONT,
								lineClamp: 1,
							}),
						],
					}),
				],
			}),
		],
	})
}

/**
 * One renderer for the whole build, with Geist registered and the feature art
 * preloaded. takumi ignores woff2, so the fontsource files are decompressed to
 * TrueType first.
 */
let renderer: Promise<{ engine: Renderer; images: { src: string; data: Uint8Array }[] }> | undefined

const makeRenderer = async () => {
	const engine = new Renderer()
	const fonts = [
		{ name: DISPLAY_FONT, file: "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2" },
		{ name: MONO_FONT, file: "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2" },
	]
	for (const font of fonts) {
		const woff2 = await readFile(new URL(`node_modules/${font.file}`, landing))
		engine.registerFont({ name: font.name, data: new Uint8Array(await decompress(woff2)) })
	}
	const arts = [...new Set([...GROUP_ART.values(), DEFAULT_ART])]
	const images = await Promise.all(
		arts.map(async (art) => {
			const src = `art/features/${art}.webp`
			return { src, data: new Uint8Array(await readFile(new URL(`public/${src}`, landing))) }
		}),
	)
	return { engine, images }
}

export const renderDocsOg = async (input: DocsOgInput): Promise<Uint8Array<ArrayBuffer>> => {
	renderer ??= makeRenderer()
	const { engine, images } = await renderer
	return engine.render(docsOgCard(input), {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		images,
		format: "jpeg",
		quality: 88,
	})
}
