import type * as Markdown from "@foldkit/markdown"
import { Effect, Option, Schema } from "effect"

// `@streamdown/code` (Shiki, github-light / github-dark): a fenced block's tokens with the style
// Streamdown's `CodeBlockBody` puts on each span. Shiki loads on the first fence, never at startup.

/** One token: its text, its inline style entries in Streamdown's order, and whether it has a fill. */
export const CodeToken = Schema.Struct({
	content: Schema.String,
	style: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
	hasBackground: Schema.Boolean,
})
export type CodeToken = typeof CodeToken.Type

export const HighlightedCode = Schema.Struct({ lines: Schema.Array(Schema.Array(CodeToken)) })
export type HighlightedCode = typeof HighlightedCode.Type

/** The fences Shiki colours: every code block but a chart or a diagram, at any depth. */
export const highlightedFences = (
	blocks: ReadonlyArray<Markdown.Block>,
): ReadonlyArray<{ readonly language: string; readonly code: string }> =>
	blocks.flatMap((block) => {
		switch (block._tag) {
			case "CodeBlock": {
				const language = Option.getOrElse(block.maybeLanguage, () => "")
				return language === "chart" || language === "mermaid" || language === "math"
					? []
					: [{ language, code: block.value }]
			}
			case "List":
				return block.items.flatMap((item) => highlightedFences(item.blocks))
			case "Blockquote":
			case "Island":
				return highlightedFences(block.blocks)
			default:
				return []
		}
	})

/** The cache key of one fence: its language and source. */
export const highlightKey = (language: string, code: string): string => `${language}\n${code}`

const StyleRecord = Schema.Record(Schema.String, Schema.String)
const decodeStyle = Schema.decodeUnknownOption(StyleRecord)

type ShikiToken = Readonly<{ content: string; color?: string; bgColor?: string; htmlStyle?: unknown }>

type StyleEntry = readonly [string, string]

/** Sets `name` in the entry list, keeping the first position a key took (object key order). */
const setEntry = (
	entries: ReadonlyArray<StyleEntry>,
	name: string,
	value: string,
): ReadonlyArray<StyleEntry> =>
	entries.some(([key]) => key === name)
		? entries.map((entry): StyleEntry => (entry[0] === name ? [name, value] : entry))
		: [...entries, [name, value]]

/** `CodeBlockBody`'s span style: `color` → `--sdm-c`, a fill → `--sdm-tbg`, the rest as Shiki wrote it. */
const tokenOf = (token: ShikiToken): CodeToken => {
	const withColor = token.color === undefined ? [] : setEntry([], "--sdm-c", token.color)
	const withFill = token.bgColor === undefined ? withColor : setEntry(withColor, "--sdm-tbg", token.bgColor)
	const extra = Object.entries(Option.getOrElse(decodeStyle(token.htmlStyle), () => ({})))
	const entries = extra.reduce(
		(acc, [key, value]) =>
			setEntry(
				acc,
				key === "color" ? "--sdm-c" : key === "background-color" ? "--sdm-tbg" : key,
				value,
			),
		withFill,
	)
	return {
		content: token.content,
		style: entries.map(([key, value]) => [key, value]),
		hasBackground: token.bgColor !== undefined || extra.some(([key]) => key === "background-color"),
	}
}

/** Shiki's language for a fence (`@streamdown/code` resolves aliases, unknown ones are plain text). */
export const highlight = (language: string, code: string) =>
	Effect.promise(() => import("shiki")).pipe(
		Effect.flatMap(({ bundledLanguages, bundledLanguagesInfo, codeToTokens }) => {
			const requested = language.trim().toLowerCase()
			const alias = bundledLanguagesInfo.find((info) => (info.aliases ?? []).includes(requested))?.id
			const resolved = alias ?? requested
			const isBundled = (value: string): value is keyof typeof bundledLanguages =>
				value in bundledLanguages
			return Effect.tryPromise(() =>
				codeToTokens(code, {
					lang: isBundled(resolved) ? resolved : "text",
					themes: { light: "github-light", dark: "github-dark" },
				}),
			)
		}),
		Effect.map((result): HighlightedCode => ({ lines: result.tokens.map((line) => line.map(tokenOf)) })),
	)
