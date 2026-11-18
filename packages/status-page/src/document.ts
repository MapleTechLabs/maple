import type { StatusPagePublicSnapshot } from "@maple/domain/status-page"
import { escapeHtml } from "@maple/strings"
import { safeImageUrl, safeUrl } from "./escape"
import { baseStyles, presetStyles } from "./styles"
import { resolveSafeTheme, safeTheme } from "./theme"
import { Option, Array as Arr, String as Str } from "effect"

export interface RenderOptions {
	/** CSP nonce for the inline style and script; omitted for static copies. */
	readonly nonce?: string
	/** Prefix of the page's own links: `""` on its own host, `/s/<org key>/<slug>` on a shared one. */
	readonly basePath?: string
	/** The page's absolute address (origin and base path), for text that must carry one: the Slack command. */
	readonly publicUrl?: string
	/** The dashboard's editor preview: what it can edit carries an id to select it by. Never public. */
	readonly preview?: boolean
	/** Drawn inside the dashboard from a one-off read: no delayed banner, which would only track how long the tab has been open. */
	readonly inDashboard?: boolean
}

/** The page settings the editor's preview can jump to: the header and footer that no component or incident owns. */
export const PREVIEW_FIELDS = [
	"name",
	"logoUrl",
	"logoDarkUrl",
	"websiteUrl",
	"supportUrl",
	"privacyUrl",
	"termsUrl",
	"showPoweredBy",
] as const
export type PreviewField = (typeof PREVIEW_FIELDS)[number]

export const nonceAttr = (options: RenderOptions): string =>
	options.nonce === undefined ? "" : ` nonce="${escapeHtml(options.nonce)}"`

/**
 * ` data-<kind>-id="<id>"` on a preview render, nothing on the public page. A group is named by its
 * first component; a field by its `PreviewField`.
 */
export const previewIdAttr = (
	options: RenderOptions,
	kind: "component" | "incident" | "group" | "field",
	id: string,
): string => (options.preview === true ? ` data-${kind}-id="${escapeHtml(id)}"` : "")

export const pageHref = (options: RenderOptions, path: string): string =>
	escapeHtml(`${options.basePath ?? ""}${path}`)

/**
 * The logo for the page's mode. Either variant alone serves both modes; with both, an auto page
 * swaps to the dark one when the visitor's scheme is dark.
 */
const renderLogo = (
	snapshot: StatusPagePublicSnapshot,
	name: string,
): { readonly html: string; readonly field: PreviewField } | null => {
	const light = safeImageUrl(snapshot.page.logoUrl)
	const dark = safeImageUrl(snapshot.page.logoDarkUrl)
	const appearance = safeTheme(snapshot.page.theme).appearance
	const img = (src: string) => `<img src="${escapeHtml(src)}" alt="${name}">`
	if (light === null) return dark === null ? null : { html: img(dark), field: "logoDarkUrl" }
	if (dark === null) return { html: img(light), field: "logoUrl" }
	if (appearance === "light") return { html: img(light), field: "logoUrl" }
	if (appearance === "dark") return { html: img(dark), field: "logoDarkUrl" }
	return {
		html: `<picture><source srcset="${escapeHtml(dark)}" media="(prefers-color-scheme: dark)">${img(light)}</picture>`,
		field: "logoUrl",
	}
}

/** Logo (or name) linking home, the support and website links when set, then any `extra` links. */
export const renderHeader = (
	snapshot: StatusPagePublicSnapshot,
	options: RenderOptions,
	extra = "",
): string => {
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
	const mark =
		logo === null ? `<span class="mono-mark" aria-hidden="true">${initial}</span>${name}` : logo.html
	const help =
		support === null
			? ""
			: `<a class="site" href="${escapeHtml(support)}" rel="noopener"${previewIdAttr(options, "field", "supportUrl")}>Contact support</a>`
	const site =
		website === null
			? ""
			: `<a class="site" href="${escapeHtml(website)}" rel="noopener"${previewIdAttr(options, "field", "websiteUrl")}>Visit website</a>`
	const brand = previewIdAttr(options, "field", logo === null ? "name" : logo.field)
	return `<header class="top"><a class="brand" href="${pageHref(options, "/")}"${brand}>${mark}</a>${help}${site}${extra}</header>`
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
	const favicon = safeImageUrl(input.snapshot.page.faviconUrl)
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
