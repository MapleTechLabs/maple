import type { Lang as Supported, Theme } from "@pierre/highlights"
import { Effect, Array as Arr, String as Str } from "effect"
import { DISPLAY_MAX_CHARS } from "./display-text"

/** A language name or alias (`json`, `shell`), or a file name whose extension names one. */
export type Lang = string

// Highlighting runs in a WebAssembly lexer per language, imported on first use so its ~250 KB of
// wasm stays out of the entry chunk. Colours are `var(--sh-<slot>)`, the palette
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

type Highlights = typeof import("@pierre/highlights")

let highlights: Highlights | null = null
let loading: Promise<Highlights> | null = null

/** Text rendered before the highlighter loaded; coloured in place once it has. */
const PENDING = "data-highlight-lang"

const colourPending = () => {
	if (typeof document === "undefined") return
	document.querySelectorAll<HTMLElement>(`[${PENDING}]`).forEach((element) => {
		element.outerHTML = highlightCode(element.textContent, element.getAttribute(PENDING) ?? "text")
	})
}

const load = (): Promise<Highlights> => {
	loading ??= import("@pierre/highlights").then(
		(module) => {
			highlights = module
			colourPending()
			return module
		},
		(error: unknown) => {
			// A failed chunk load is retried by the next reader.
			loading = null
			return Promise.reject(error)
		},
	)
	return loading
}

/** Waits for the highlighter, so a caller's synchronous highlight that follows is coloured. */
export const awaitHighlighter: Effect.Effect<void> = Effect.promise(load).pipe(
	Effect.asVoid,
	Effect.orElseSucceed(() => undefined),
)

/** Whether the highlighter has loaded; tokens taken before then are plain and not worth keeping. */
export const isHighlighterReady = (): boolean => highlights !== null

/** The supported language `label` names: itself, else a file name's extension, else plain text. */
const resolveLang = (module: Highlights, label: Lang): Supported => {
	const name = Str.toLowerCase(Str.trim(label))
	if (module.isSupportedLanguage(name)) return name
	const extension = Str.slice(name.lastIndexOf(".") + 1)(name)
	return Str.includes(".")(name) && module.isSupportedLanguage(extension) ? extension : "text"
}

const escapeHtml = (text: string): string =>
	Str.replace(/>/g, "&gt;")(Str.replace(/</g, "&lt;")(Str.replace(/&/g, "&amp;")(text)))

const escapeAttribute = (text: string): string => Str.replace(/"/g, "&quot;")(escapeHtml(text))

/**
 * Highlighted HTML for `code` (token spans only, for the caller's own `<code>`). Past the display
 * cap it is escaped plain text: a span per token of a megabyte log body froze the log sheet. Until
 * the highlighter loads it is plain text too, coloured in place when it arrives.
 */
export const highlightCode = (code: string, lang: Lang): string => {
	if (code.length > DISPLAY_MAX_CHARS) return escapeHtml(code)
	if (highlights === null) {
		void load().catch(() => undefined)
		return `<span ${PENDING}="${escapeAttribute(lang)}">${escapeHtml(code)}</span>`
	}
	const html = decoder.decode(highlights.codeToHtml(code, { lang: resolveLang(highlights, lang), theme }))
	return Str.slice(html.indexOf("<code>") + "<code>".length, html.lastIndexOf("</code>"))(html)
}

const SLOT = /^var\(--sh-([\w-]+)\)$/

/**
 * `code` as lines of tokens with their palette slot, for a view that builds its own spans. Plain
 * lines until the highlighter loaded: a caller that keeps the tokens waits on `awaitHighlighter`.
 */
export const highlightTokens = (
	code: string,
	lang: Lang,
): ReadonlyArray<ReadonlyArray<{ readonly content: string; readonly slot: string }>> =>
	highlights === null
		? Arr.map(Str.split("\n")(code), (line) =>
				line === "" ? [] : [{ content: line, slot: "foreground" }],
			)
		: Arr.map(
				highlights.codeToTokens(code, { lang: resolveLang(highlights, lang), theme }).tokens,
				(line) =>
					Arr.flatMap(line, (token) =>
						token.content === ""
							? []
							: [
									{
										content: token.content,
										slot: SLOT.exec(token.color ?? "")?.[1] ?? "foreground",
									},
								],
					),
			)
