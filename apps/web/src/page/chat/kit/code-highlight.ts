import type * as Markdown from "@foldkit/markdown"
import { Option, Schema } from "effect"
import { highlightTokens, resolveLang } from "../../../lib/highlight"

// A fenced block's tokens. Each token is coloured by its `--sh-<slot>` theme variable (`theme.css`);
// a language the highlighter does not know is plain text.

/** One token: its text and its palette slot (`keyword`, `string`, `comment`, ...). */
export const CodeToken = Schema.Struct({ content: Schema.String, slot: Schema.String })
export type CodeToken = typeof CodeToken.Type

export const HighlightedCode = Schema.Struct({ lines: Schema.Array(Schema.Array(CodeToken)) })
export type HighlightedCode = typeof HighlightedCode.Type

/** The fences that get coloured: every code block but a chart, at any depth. */
export const highlightedFences = (
	blocks: ReadonlyArray<Markdown.Block>,
): ReadonlyArray<{ readonly language: string; readonly code: string }> =>
	blocks.flatMap((block) => {
		switch (block._tag) {
			case "CodeBlock": {
				const language = Option.getOrElse(block.maybeLanguage, () => "")
				return language === "chart" ? [] : [{ language, code: block.value }]
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

/** A fence's tokens, by its language or an alias of one (`py`, `SQL`). */
export const highlight = (language: string, code: string): HighlightedCode => ({
	lines: highlightTokens(code, resolveLang(language)),
})
