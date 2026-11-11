import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { escapeHtml } from "@maple/strings"
import { safeUrl } from "./escape"
import { baseStyles, presetStyles } from "./styles"
import { resolveSafeTheme, safeTheme } from "./theme"
import { Option, Array as Arr, String as Str } from "effect"

export interface RenderOptions {
	/** CSP nonce for the inline style and script; omitted for static copies. */
	readonly nonce?: string
	/** Prefix of the page's own links: `""` on its own host, `/s/<slug>` on a shared one. */
	readonly basePath?: string
	/** The page's absolute address (origin and base path), for text that must carry one: the Slack command. */
	readonly publicUrl?: string
	/** The dashboard's editor preview: components and incidents carry ids it can select by. Never public. */
	readonly preview?: boolean
}

export const nonceAttr = (options: RenderOptions): string =>
	options.nonce === undefined ? "" : ` nonce="${escapeHtml(options.nonce)}"`

/** ` data-<kind>-id="<id>"` on a preview render, nothing on the public page. */
export const previewIdAttr = (options: RenderOptions, kind: "component" | "incident", id: string): string =>
	options.preview === true ? ` data-${kind}-id="${escapeHtml(id)}"` : ""

export const pageHref = (options: RenderOptions, path: string): string =>
	escapeHtml(`${options.basePath ?? ""}${path}`)

/** The logo (or the name behind a monogram) linking to the page's home. */
export const renderBrand = (snapshot: StatusPageSnapshot, options: RenderOptions): string => {
	const name = escapeHtml(snapshot.page.name)
	const logo = safeUrl(snapshot.page.logoUrl, ["https:"])
	// Without a logo, a monogram in the theme's brand colour stands in for one.
	const initial = escapeHtml(
		Option.match(Arr.head(Array.from(Str.trim(snapshot.page.name))), {
			onNone: () => "",
			onSome: (first) => Str.toUpperCase(first),
		}),
	)
	const mark =
		logo === null
			? `<span class="mono-mark" aria-hidden="true">${initial}</span>${name}`
			: `<img src="${escapeHtml(logo)}" alt="${name}">`
	return `<a class="brand" href="${pageHref(options, "/")}">${mark}</a>`
}

/** Logo (or name) linking home, the customer's website when set, then any `extra` links. */
export const renderHeader = (snapshot: StatusPageSnapshot, options: RenderOptions, extra = ""): string => {
	const website = safeUrl(snapshot.page.websiteUrl, ["https:", "http:"])
	const site =
		website === null
			? ""
			: `<a class="site" href="${escapeHtml(website)}" rel="noopener">Visit website</a>`
	return `<header class="top">${renderBrand(snapshot, options)}${site}${extra}</header>`
}

export const renderDocument = (input: {
	readonly snapshot: StatusPageSnapshot
	readonly options: RenderOptions
	readonly title: string
	readonly styles: string
	readonly body: string
	readonly bodyAttrs?: string
	readonly head?: string
	readonly script?: string
}): string => {
	const nonce = nonceAttr(input.options)
	const description = input.snapshot.page.description
	const theme = safeTheme(input.snapshot.page.theme)
	return Arr.join(
		[
			`<!doctype html><html lang="en"><head><meta charset="utf-8">`,
			`<meta name="viewport" content="width=device-width,initial-scale=1">`,
			`<title>${escapeHtml(input.title)}</title>`,
			description === null ? "" : `<meta name="description" content="${escapeHtml(description)}">`,
			input.head ?? "",
			`<style${nonce}>${baseStyles(resolveSafeTheme(theme))}${input.styles}${presetStyles(theme.preset)}</style>`,
			`</head><body${input.bodyAttrs ?? ""}><main class="wrap">`,
			input.body,
			`</main>`,
			input.script === undefined ? "" : `<script${nonce}>${input.script}</script>`,
			`</body></html>`,
		],
		"",
	)
}
