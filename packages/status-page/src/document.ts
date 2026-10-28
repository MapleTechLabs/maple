import type { StatusPageSnapshot } from "@maple/domain/status-page"
import { escapeHtml, safeColor, safeUrl } from "./escape"
import { baseStyles } from "./styles"

export interface RenderOptions {
	/** CSP nonce for the inline style and script; omitted for static copies. */
	readonly nonce?: string
	/** Prefix of the page's own links: `""` on its own host, `/s/<slug>` on a shared one. */
	readonly basePath?: string
}

export const nonceAttr = (options: RenderOptions): string =>
	options.nonce === undefined ? "" : ` nonce="${escapeHtml(options.nonce)}"`

export const pageHref = (options: RenderOptions, path: string): string =>
	escapeHtml(`${options.basePath ?? ""}${path}`)

/** Logo (or name) linking home, and the customer's website when set. */
export const renderHeader = (snapshot: StatusPageSnapshot, options: RenderOptions): string => {
	const name = escapeHtml(snapshot.page.name)
	const logo = safeUrl(snapshot.page.logoUrl, ["https:"])
	const website = safeUrl(snapshot.page.websiteUrl, ["https:", "http:"])
	const mark = logo === null ? name : `<img src="${escapeHtml(logo)}" alt="${name}">`
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
	return [
		`<!doctype html><html lang="en"><head><meta charset="utf-8">`,
		`<meta name="viewport" content="width=device-width,initial-scale=1">`,
		`<title>${escapeHtml(input.title)}</title>`,
		description === null ? "" : `<meta name="description" content="${escapeHtml(description)}">`,
		input.head ?? "",
		`<style${nonce}>${baseStyles(safeColor(input.snapshot.page.brandColor))}${input.styles}</style>`,
		`</head><body${input.bodyAttrs ?? ""}><main class="wrap">`,
		input.body,
		`</main>`,
		input.script === undefined ? "" : `<script${nonce}>${input.script}</script>`,
		`</body></html>`,
	].join("")
}
