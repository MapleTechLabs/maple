import * as Markdown from "@foldkit/markdown"
import { Effect, Schema, Array as Arr, String as Str } from "effect"

// The one markdown parse every page uses (chat, agent sessions). `@foldkit/markdown`'s pipeline
// includes remark-directive, which reads `:name` in prose as an inline directive and rejects the
// document ("at 14:03"). Streamdown has no directives, so such a colon is escaped first; code spans
// and fences are left as written, since a backslash is literal there.

/** A parsed body; `null` when the text holds a construct the vocabulary rejects (raw HTML). */
export const ParsedMarkdown = Schema.Struct({
	text: Schema.String,
	document: Schema.NullOr(Markdown.MarkdownDocument),
})
export type ParsedMarkdown = typeof ParsedMarkdown.Type

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Escapes `:` before a word character in prose (outside code spans), so remark reads it as text. */
const escapeLine = (line: string): string =>
	Arr.join(
		Arr.map(Str.split(/(`+[^`]*`+)/)(line), (piece, index) =>
			index % 2 === 1 ? piece : Str.replace(/:(?=[\p{L}\p{N}_])/gu, "\\:")(piece),
		),
		"",
	)

type Scan = Readonly<{ lines: ReadonlyArray<string>; fence: string | null }>

/** Every prose line escaped; lines inside a fenced block pass through until its closing fence. */
export const escapeDirectives = (text: string): string =>
	Arr.join(
		Str.split("\n")(text).reduce<Scan>(
			(acc, line) => {
				const marker = FENCE.exec(line)?.[1]
				if (acc.fence !== null) {
					const closes =
						marker !== undefined &&
						marker[0] === acc.fence[0] &&
						marker.length >= acc.fence.length
					return { lines: [...acc.lines, line], fence: closes ? null : acc.fence }
				}
				if (marker !== undefined) return { lines: [...acc.lines, line], fence: marker }
				return { lines: [...acc.lines, escapeLine(line)], fence: null }
			},
			{ lines: [], fence: null },
		).lines,
		"\n",
	)

/** The remark pipeline threw on a text. */
export class MarkdownParseError extends Schema.TaggedError<MarkdownParseError>()(
	"@maple/web/kit/MarkdownParseError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** Each text parsed by the lazily imported remark pipeline; a rejected text parses to `null`. */
export const parseMarkdownTexts = (texts: ReadonlyArray<string>) =>
	Effect.promise(() => import("@foldkit/markdown/vite")).pipe(
		Effect.flatMap(({ parseMarkdown }) =>
			Effect.forEach(texts, (text) =>
				Effect.try({
					try: () => parseMarkdown(escapeDirectives(text)),
					catch: (cause) =>
						new MarkdownParseError({ message: "The remark pipeline rejected the text", cause }),
				}).pipe(
					Effect.map((document): ParsedMarkdown => ({ text, document })),
					Effect.orElseSucceed((): ParsedMarkdown => ({ text, document: null })),
				),
			),
		),
	)
