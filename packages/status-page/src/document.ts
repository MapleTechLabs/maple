import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { escapeHtml, safeUrl } from "./escape"
import { baseStyles, presetStyles } from "./styles"
import { resolveSafeTheme, safeTheme } from "./theme"

export interface RenderOptions {
	/** CSP nonce for the inline style and script; omitted for static copies. */
	readonly nonce?: string
	/** Prefix of the page's own links: `""` on its own host, `/s/<slug>` on a shared one. */
	readonly basePath?: string
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

/** Logo (or name) linking home, and the customer's website when set. */
export const renderHeader = (snapshot: StatusPageSnapshot, options: RenderOptions): string => {
	const name = escapeHtml(snapshot.page.name)
	const logo = safeUrl(snapshot.page.logoUrl, ["https:"])
	const website = safeUrl(snapshot.page.websiteUrl, ["https:", "http:"])
	// Without a logo, a monogram in the theme's brand colour stands in for one.
	const initial = escapeHtml(Array.from(snapshot.page.name.trim())[0]?.toUpperCase() ?? "")
	const mark =
		logo === null
			? `<span class="mono-mark" aria-hidden="true">${initial}</span>${name}`
			: `<img src="${escapeHtml(logo)}" alt="${name}">`
	const site =
		website === null
			? ""
			: `<a class="site" href="${escapeHtml(website)}" rel="noopener">Visit website</a>`
	return `<header class="top"><a class="brand" href="${pageHref(options, "/")}">${mark}</a>${site}</header>`
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
	// The preset sets its shadow in `presetStyles`; its colours come in as tokens.
	const preset = safeTheme(input.snapshot.page.theme).preset
	return [
		`<!doctype html><html lang="en" data-preset="${preset}"><head><meta charset="utf-8">`,
		`<meta name="viewport" content="width=device-width,initial-scale=1">`,
		`<title>${escapeHtml(input.title)}</title>`,
		description === null ? "" : `<meta name="description" content="${escapeHtml(description)}">`,
		input.head ?? "",
		`<style${nonce}>${baseStyles(resolveSafeTheme(input.snapshot.page.theme))}${input.styles}${presetStyles}</style>`,
		`</head><body${input.bodyAttrs ?? ""}><main class="wrap">`,
		input.body,
		`</main>`,
		input.script === undefined ? "" : `<script${nonce}>${input.script}</script>`,
		`</body></html>`,
	].join("")
}
