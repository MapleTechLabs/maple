import type { StatusPagePublicSnapshot } from "@maple/domain/status-page"
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

/**
 * The logo for the page's mode. Either variant alone serves both modes; with both, an auto page
 * swaps to the dark one when the visitor's scheme is dark.
 */
const renderLogo = (snapshot: StatusPagePublicSnapshot, name: string): string | null => {
	const light = safeUrl(snapshot.page.logoUrl, ["https:"])
	const dark = safeUrl(snapshot.page.logoDarkUrl, ["https:"])
	const appearance = safeTheme(snapshot.page.theme).appearance
	const img = (src: string) => `<img src="${escapeHtml(src)}" alt="${name}">`
	if (light === null || dark === null) {
		const only = light ?? dark
		return only === null ? null : img(only)
	}
	if (appearance === "light") return img(light)
	if (appearance === "dark") return img(dark)
	return `<picture><source srcset="${escapeHtml(dark)}" media="(prefers-color-scheme: dark)">${img(light)}</picture>`
}

/** Logo (or name) linking home, the support and website links when set, then any `extra` links. */
export const renderHeader = (snapshot: StatusPagePublicSnapshot, options: RenderOptions, extra = ""): string => {
	const name = escapeHtml(snapshot.page.name)
	const logo = renderLogo(snapshot, name)
	const website = safeUrl(snapshot.page.websiteUrl, ["https:", "http:"])
	const support = safeUrl(snapshot.page.supportUrl, ["https:"])
	// Without a logo, a monogram in the theme's brand colour stands in for one.
	const initial = escapeHtml(
		Option.match(Arr.head(Array.from(Str.trim(snapshot.page.name))), {
			onNone: () => "",
			onSome: (first) => Str.toUpperCase(first),
		}),
	)
	const mark = logo === null ? `<span class="mono-mark" aria-hidden="true">${initial}</span>${name}` : logo
	const help =
		support === null
			? ""
			: `<a class="site" href="${escapeHtml(support)}" rel="noopener">Contact support</a>`
	const site =
		website === null
			? ""
			: `<a class="site" href="${escapeHtml(website)}" rel="noopener">Visit website</a>`
	return `<header class="top"><a class="brand" href="${pageHref(options, "/")}">${mark}</a>${help}${site}${extra}</header>`
}

export const renderDocument = (input: {
	readonly snapshot: StatusPagePublicSnapshot
	readonly options: RenderOptions
	readonly title: string
	readonly styles: string
	readonly body: string
	readonly bodyAttrs?: string
	readonly head?: string
	readonly script?: string
	/** The meta description; the page's own description when omitted. */
	readonly description?: string
}): string => {
	const nonce = nonceAttr(input.options)
	const description = input.description ?? input.snapshot.page.description
	const theme = safeTheme(input.snapshot.page.theme)
	const favicon = safeUrl(input.snapshot.page.faviconUrl, ["https:"])
	return Arr.join(
		[
			`<!doctype html><html lang="en"><head><meta charset="utf-8">`,
			`<meta name="viewport" content="width=device-width,initial-scale=1">`,
			`<title>${escapeHtml(input.title)}</title>`,
			description === null ? "" : `<meta name="description" content="${escapeHtml(description)}">`,
			favicon === null ? "" : `<link rel="icon" href="${escapeHtml(favicon)}">`,
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
