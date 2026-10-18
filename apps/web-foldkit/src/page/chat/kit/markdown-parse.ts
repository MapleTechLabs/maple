import { Effect } from "effect"
import type { ParsedMarkdown } from "../../agent-sessions/session/message-response"

// The chat's markdown parse. `@foldkit/markdown`'s pipeline includes remark-directive, which reads
// any `:name` in prose as an inline directive and rejects the document ("at 14:03"). Streamdown has
// no directives, so a colon that would open one is escaped first; code spans and fences are left
// as written, since backslashes are literal there.

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Escapes `:` before a word character in prose (outside code spans), so remark reads it as text. */
const escapeLine = (line: string): string =>
	line
		.split(/(`+[^`]*`+)/)
		.map((piece, index) => (index % 2 === 1 ? piece : piece.replace(/:(?=[\p{L}\p{N}_])/gu, "\\:")))
		.join("")

export const escapeDirectives = (text: string): string =>
	text
		.split("\n")
		.reduce<{ readonly lines: ReadonlyArray<string>; readonly fence: string | null }>(
			(acc, line) => {
				const marker = FENCE.exec(line)?.[1]
				if (acc.fence !== null)
					return {
						lines: [...acc.lines, line],
						fence: marker !== undefined && marker[0] === acc.fence[0] && marker.length >= acc.fence.length ? null : acc.fence,
					}
				if (marker !== undefined) return { lines: [...acc.lines, line], fence: marker }
				return { lines: [...acc.lines, escapeLine(line)], fence: null }
			},
			{ lines: [], fence: null },
		)
		.lines.join("\n")

/** Each text parsed by the lazily imported remark pipeline; a rejected text parses to `null`. */
export const parseChatMarkdown = (texts: ReadonlyArray<string>) =>
	Effect.promise(() => import("@foldkit/markdown/vite")).pipe(
		Effect.flatMap(({ parseMarkdown }) =>
			Effect.forEach(texts, (text) =>
				Effect.try(() => parseMarkdown(escapeDirectives(text))).pipe(
					Effect.map((document): ParsedMarkdown => ({ text, document })),
					Effect.orElseSucceed((): ParsedMarkdown => ({ text, document: null })),
				),
			),
		),
	)
