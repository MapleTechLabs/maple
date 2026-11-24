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
		Arr.reduce<string, Scan>(Str.split("\n")(text), { lines: [], fence: null }, (acc, line) => {
			const marker = FENCE.exec(line)?.[1]
			if (acc.fence !== null) {
				const closes =
					marker !== undefined && marker[0] === acc.fence[0] && marker.length >= acc.fence.length
				return { lines: [...acc.lines, line], fence: closes ? null : acc.fence }
			}
			if (marker !== undefined) return { lines: [...acc.lines, line], fence: marker }
			return { lines: [...acc.lines, escapeLine(line)], fence: null }
		}).lines,
		"\n",
	)

/** The remark pipeline threw on a text. */
export class MarkdownParseError extends Schema.TaggedError<MarkdownParseError>()(
	"@maple/web/kit/MarkdownParseError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

class MarkdownParserLoadError extends Schema.TaggedError<MarkdownParserLoadError>()(
	"@maple/web/kit/MarkdownParserLoadError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

const unparsed = (texts: ReadonlyArray<string>): Array<ParsedMarkdown> =>
	Arr.map(texts, (text) => ({ text, document: null }))

type ParserModule = Pick<typeof import("@foldkit/markdown/vite"), "parseMarkdown">

/**
 * Each text parsed by the remark pipeline `load` imports; a rejected text parses to `null`. A
 * parser chunk that fails to load (a tab on a superseded build) leaves every text plain.
 */
export const parseMarkdownTextsWith =
	(load: () => Promise<ParserModule>) =>
	(texts: ReadonlyArray<string>): Effect.Effect<Array<ParsedMarkdown>> =>
		Effect.tryPromise({
			try: load,
			catch: (cause) =>
				new MarkdownParserLoadError({ message: "The markdown parser failed to load", cause }),
		}).pipe(
			Effect.tapError((error) => Effect.logWarning(error.message)),
			Effect.matchEffect({
				onFailure: () => Effect.succeed(unparsed(texts)),
				onSuccess: ({ parseMarkdown }) =>
					Effect.forEach(texts, (text) =>
						Effect.try({
							try: () => parseMarkdown(escapeDirectives(text)),
							catch: (cause) =>
								new MarkdownParseError({
									message: "The remark pipeline rejected the text",
									cause,
								}),
						}).pipe(
							Effect.map((document): ParsedMarkdown => ({ text, document })),
							Effect.orElseSucceed((): ParsedMarkdown => ({ text, document: null })),
						),
					),
			}),
		)

/** `parseMarkdownTextsWith` the lazily imported parser chunk. */
export const parseMarkdownTexts = parseMarkdownTextsWith(() => import("@foldkit/markdown/vite"))
