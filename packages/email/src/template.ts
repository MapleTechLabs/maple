import { String as Str } from "effect"
/**
 * The whole email runtime: HTML escaping plus a token/slot splicer for the
 * templates compiled into `src/generated/`.
 *
 * Zero dependencies on purpose — this runs inside the API Worker, where
 * pulling react + react-email in just to produce a string was the problem this
 * package exists to solve.
 */

/** Escapes into a form that is safe in both text nodes and quoted attributes. */
export function escapeHtml(value: string): string {
	return Str.replace(
		/'/g,
		"&#39;",
	)(
		Str.replace(
			/"/g,
			"&quot;",
		)(Str.replace(/>/g, "&gt;")(Str.replace(/</g, "&lt;")(Str.replace(/&/g, "&amp;")(value)))),
	)
}

const TOKEN = /\[\[(#?)([A-Za-z0-9_]+)\]\]/g

/**
 * Fills one compiled template.
 *
 * `[[name]]` takes a value from `values` and is **always HTML-escaped**.
 * `[[#name]]` takes pre-rendered markup from `slots` and is inserted verbatim —
 * only ever fed strings this module built from other templates.
 *
 * Substituted text is never rescanned, so a `[[…]]` sequence inside user data
 * cannot smuggle in a second round of interpolation. An unknown token throws
 * rather than shipping a placeholder to a recipient's inbox.
 */
export function fill(
	template: string,
	values: Readonly<Record<string, string>> = {},
	slots: Readonly<Record<string, string>> = {},
): string {
	// @effect-diagnostics-next-line preferEffectString:off -- function replacer; Str.replace only takes a string
	return template.replace(TOKEN, (_match, raw: string, name: string) => {
		if (raw === "#") {
			const slot = slots[name]
			if (slot === undefined) throw new Error(`Email template is missing slot "${name}"`)
			return slot
		}
		const value = values[name]
		if (value === undefined) throw new Error(`Email template is missing value "${name}"`)
		return escapeHtml(value)
	})
}

/**
 * The hidden preheader padding react-email used: enough zero-width filler to
 * stop the client from spilling body copy into the inbox preview line.
 */
const PREHEADER_UNIT = " ‌​‍‎‏﻿"
const PREHEADER_TARGET = 150

export function preheaderPadding(previewText: string): string {
	return Str.repeat(Math.max(0, PREHEADER_TARGET - previewText.length))(PREHEADER_UNIT)
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${Str.slice(0, max)(text)}…` : text
}
