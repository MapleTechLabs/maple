import { escapeHtml } from "@maple/strings"
import { Array as Arr, String as Str } from "effect"
import { safeUrl } from "./escape"

// Incident update text: paragraphs, bullet and numbered lists, **bold**, *italic*, `code`,
// [links](https://...) and bare URLs. Everything else is escaped text; no raw HTML passes.

type BlockKind = "p" | "ul" | "ol"

interface Block {
	readonly kind: BlockKind
	readonly lines: ReadonlyArray<string>
}

/** A block still being filled; see `blocks`. */
interface OpenBlock {
	readonly kind: BlockKind
	readonly lines: Array<string>
}

/** The longest update body allowed. A longer line is not parsed for inline marks, only escaped. */
const MAX_INLINE_CHARS = 20_000

// The link label and target are length-capped, so a `[` with no link after it costs a fixed amount
// of matching instead of a scan to the end of the line.
const INLINE =
	/`([^`\n]+)`|\[([^\]\n]{1,500})\]\(([^\s)]{1,2000})\)|(https?:\/\/[^\s<>"]+)|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\s][^*\n]*)\*(?![\w*])/gu

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
	if (text.length > MAX_INLINE_CHARS) return escapeHtml(text)
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
const blocks = (text: string): ReadonlyArray<Block> => {
	// Filled in place: copying the list for every line makes a body of many lines cost its square.
	const out: Array<OpenBlock> = []
	Arr.reduce(Str.split("\n")(Str.replaceAll("\r\n", "\n")(text)), false, (open, line) => {
		if (Str.trim(line) === "") return false
		const { kind, text: content } = classify(line)
		const last = open ? out.at(-1) : undefined
		const item = last?.lines.at(-1)
		// An indented line under a list item is that item's wrapped text, not a new paragraph.
		if (
			last !== undefined &&
			item !== undefined &&
			last.kind !== "p" &&
			kind === "p" &&
			/^\s/u.test(line)
		)
			last.lines[last.lines.length - 1] = `${item} ${Str.trim(line)}`
		else if (last !== undefined && last.kind === kind) last.lines.push(content)
		else out.push({ kind, lines: [content] })
		return true
	})
	return out
}

const renderBlock = (block: Block): string =>
	block.kind === "p"
		? `<p>${Arr.join(Arr.map(block.lines, inline), "<br>")}</p>`
		: `<${block.kind}>${Arr.join(
				Arr.map(block.lines, (line) => `<li>${inline(line)}</li>`),
				"",
			)}</${block.kind}>`

/** An incident update's text as HTML: a small, safe subset of markdown with links. */
export const renderUpdateBody = (text: string): string => Arr.join(Arr.map(blocks(text), renderBlock), "")
