import { codeToHtml, codeToTokens, isSupportedLanguage, type Lang, type Theme } from "@pierre/highlights"

export type { Lang }

// Highlighting runs in a WebAssembly lexer per language. Colours are `var(--sh-<slot>)`, the palette
// in `theme.css`; a token type without a slot below inherits its parent's, else `--sh-foreground`.
const theme: Theme = {
	name: "maple",
	appearance: "dark",
	cssVariables: { prefix: "--sh-" },
	style: {
		syntax: {
			keyword: "keyword",
			boolean: "keyword",
			"constant.builtin": "keyword",
			number: "class",
			constant: "class",
			type: "class",
			constructor: "class",
			namespace: "class",
			string: "string",
			"diff.plus": "string",
			link_uri: "string",
			comment: "comment",
			property: "property",
			attribute: "property",
			function: "entity",
			tag: "entity",
			title: "keyword",
			"diff.minus": "keyword",
			punctuation: "sign",
			operator: "sign",
		},
	},
}

const decoder = new TextDecoder()

/**
 * The language to highlight a block as: `label` itself (`json`, `shell`, `typescript`), else the
 * extension of a file name (`maple-aws.tf`), else plain text.
 */
export const resolveLang = (label: string): Lang => {
	const name = label.trim().toLowerCase()
	if (isSupportedLanguage(name)) return name
	const extension = name.slice(name.lastIndexOf(".") + 1)
	return name.includes(".") && isSupportedLanguage(extension) ? extension : "text"
}

/** Highlighted HTML for `code` (token spans only, for the caller's own `<code>`). */
export const highlightCode = (code: string, lang: Lang): string => {
	const html = decoder.decode(codeToHtml(code, { lang, theme }))
	return html.slice(html.indexOf("<code>") + "<code>".length, html.lastIndexOf("</code>"))
}

const SLOT = /^var\(--sh-([\w-]+)\)$/

/** `code` as lines of tokens with their palette slot, for a view that builds its own spans. */
export const highlightTokens = (
	code: string,
	lang: Lang,
): ReadonlyArray<ReadonlyArray<{ readonly content: string; readonly slot: string }>> =>
	codeToTokens(code, { lang, theme }).tokens.map((line) =>
		line.flatMap((token) =>
			token.content === ""
				? []
				: [{ content: token.content, slot: SLOT.exec(token.color ?? "")?.[1] ?? "foreground" }],
		),
	)
