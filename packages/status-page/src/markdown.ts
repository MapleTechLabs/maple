import { Array as Arr, String as Str } from "effect"
import { escapeHtml } from "@maple/strings"
import { safeUrl } from "./escape"

// Incident update text: paragraphs, bullet and numbered lists, **bold**, *italic*, `code`,
// [links](https://...) and bare URLs. Everything else is escaped text; no raw HTML passes.

type BlockKind = "p" | "ul" | "ol"

interface Block {
	readonly kind: BlockKind
	readonly lines: ReadonlyArray<string>
}

const INLINE =
	/`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)|(https?:\/\/[^\s<>"]+)|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\s][^*\n]*)\*(?![\w*])/gu

const anchor = (href: string, label: string): string | null => {
	const url = safeUrl(href, ["https:", "http:"])
	return url === null ? null : `<a href="${escapeHtml(url)}" rel="noopener nofollow ugc">${label}</a>`
}

/** Sentence punctuation after a bare URL, which is not part of it. */
const trailing = (url: string): string =>
	(Str.includes("(")(url) ? /[.,;:!?]+$/u : /[.,;:!?)]+$/u).exec(url)?.[0] ?? ""

const bareLink = (text: string): string => {
	const tail = trailing(text)
	const url = Str.slice(0, text.length - tail.length)(text)
	return `${anchor(url, escapeHtml(url)) ?? escapeHtml(url)}${escapeHtml(tail)}`
}

const inline = (text: string): string => {
	const done = Arr.reduce(
		Arr.fromIterable(Str.matchAll(INLINE)(text)),
		{ html: "", at: 0 },
		(state, match) => {
			const [whole, code, label, target, bare, strong, em] = match
			const start = match.index ?? state.at
			const rendered =
				code !== undefined
					? `<code>${escapeHtml(code)}</code>`
					: label !== undefined && target !== undefined
						? (anchor(target, escapeHtml(label)) ?? escapeHtml(whole))
						: bare !== undefined
							? bareLink(bare)
							: strong !== undefined
								? `<strong>${inline(strong)}</strong>`
								: em !== undefined
									? `<em>${inline(em)}</em>`
									: escapeHtml(whole)
			return {
				html: `${state.html}${escapeHtml(Str.slice(state.at, start)(text))}${rendered}`,
				at: start + whole.length,
			}
		},
	)
	return `${done.html}${escapeHtml(Str.slice(done.at)(text))}`
}

const classify = (line: string): { readonly kind: BlockKind; readonly text: string } => {
	const bullet = /^\s*[-*]\s+(.+)$/u.exec(line)?.[1]
	if (bullet !== undefined) return { kind: "ul", text: bullet }
	const numbered = /^\s*\d+[.)]\s+(.+)$/u.exec(line)?.[1]
	if (numbered !== undefined) return { kind: "ol", text: numbered }
	return { kind: "p", text: line }
}

/** Runs of lines of one kind; a blank line ends the run. */
const blocks = (text: string): ReadonlyArray<Block> =>
	Arr.reduce(
		Str.split("\n")(Str.replaceAll("\r\n", "\n")(text)),
		{ blocks: Arr.empty<Block>(), open: false },
		(state, line) => {
			if (Str.trim(line) === "") return { blocks: state.blocks, open: false }
			const { kind, text: content } = classify(line)
			const last = state.blocks.at(-1)
			const item = last?.lines.at(-1)
			// An indented line under a list item is that item's wrapped text, not a new paragraph.
			if (
				state.open &&
				last !== undefined &&
				item !== undefined &&
				last.kind !== "p" &&
				kind === "p" &&
				/^\s/u.test(line)
			)
				return {
					blocks: [
						...state.blocks.slice(0, -1),
						{ kind: last.kind, lines: [...last.lines.slice(0, -1), `${item} ${Str.trim(line)}`] },
					],
					open: true,
				}
			return state.open && last !== undefined && last.kind === kind
				? {
						blocks: [...state.blocks.slice(0, -1), { kind, lines: [...last.lines, content] }],
						open: true,
					}
				: { blocks: [...state.blocks, { kind, lines: [content] }], open: true }
		},
	).blocks

const renderBlock = (block: Block): string =>
	block.kind === "p"
		? `<p>${Arr.join(Arr.map(block.lines, inline), "<br>")}</p>`
		: `<${block.kind}>${Arr.join(
				Arr.map(block.lines, (line) => `<li>${inline(line)}</li>`),
				"",
			)}</${block.kind}>`

/** An incident update's text as HTML: a small, safe subset of markdown with links. */
export const renderUpdateBody = (text: string): string => Arr.join(Arr.map(blocks(text), renderBlock), "")
