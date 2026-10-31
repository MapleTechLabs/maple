import { validateUrlScheme } from "@maple/ui/lib/sanitizers"
import type { Html, HtmlBuilder } from "foldkit/html"
import { inlineCode } from "../../../ui/inline-code"

// The markdown widget's renderer: headings, bullet
// and numbered lists, paragraphs; inline links, bold, italic and code.

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const LIST_RE = /^[-*]\s+(.*)$/
const ORDERED_LIST_RE = /^\d+\.\s+(.*)$/
const INLINE_RE = /(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)/g
const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/

/** `renderInline`: the text between tokens stays plain, each token its element. */
const renderInline = <M>(h: HtmlBuilder<M>, text: string): ReadonlyArray<Html | string> => {
	const matches = [...text.matchAll(INLINE_RE)]
	const pieces = matches.reduce<{ cursor: number; nodes: ReadonlyArray<Html | string> }>(
		(state, match) => {
			const segment = match[0]
			const before = match.index > state.cursor ? [text.slice(state.cursor, match.index)] : []
			return {
				cursor: match.index + segment.length,
				nodes: [...state.nodes, ...before, ...inlineToken(h, segment)],
			}
		},
		{ cursor: 0, nodes: [] },
	)
	return pieces.cursor < text.length ? [...pieces.nodes, text.slice(pieces.cursor)] : pieces.nodes
}

const inlineToken = <M>(h: HtmlBuilder<M>, segment: string): ReadonlyArray<Html | string> => {
	if (segment.startsWith("[")) {
		const link = LINK_RE.exec(segment)
		if (link === null) return []
		const label = link[1] ?? ""
		const target = link[2] ?? ""
		const safeHref = validateUrlScheme(target)
		// A `javascript:` or `data:` target renders as plain text, never a link.
		return safeHref === null
			? [
					h.span(
						[
							h.Title(`Blocked unsupported link scheme: ${target}`),
							h.Class("text-muted-foreground"),
						],
						[label],
					),
				]
			: [
					h.a(
						[
							h.Href(safeHref),
							h.Target("_blank"),
							h.Rel("noreferrer"),
							h.Class(
								"text-primary underline decoration-primary-a3 underline-offset-2 hover:decoration-primary active:decoration-primary",
							),
						],
						[label],
					),
				]
	}
	if (segment.startsWith("**")) return [h.strong([], [segment.slice(2, -2)])]
	if (segment.startsWith("*")) return [h.em([], [segment.slice(1, -1)])]
	return [inlineCode(h, {}, [segment.slice(1, -1)])]
}

type Block =
	| Readonly<{ kind: "paragraph"; text: string }>
	| Readonly<{ kind: "list"; isOrdered: boolean; items: ReadonlyArray<string> }>
	| Readonly<{ kind: "heading"; level: number; text: string }>

type ParseState = Readonly<{
	blocks: ReadonlyArray<Block>
	paragraph: ReadonlyArray<string>
	list: Readonly<{ isOrdered: boolean; items: ReadonlyArray<string> }> | null
}>

const flushParagraph = (state: ParseState): ParseState =>
	state.paragraph.length === 0
		? state
		: {
				...state,
				blocks: [...state.blocks, { kind: "paragraph", text: state.paragraph.join(" ") }],
				paragraph: [],
			}

const flushList = (state: ParseState): ParseState =>
	state.list === null || state.list.items.length === 0
		? { ...state, list: null }
		: { ...state, blocks: [...state.blocks, { kind: "list", ...state.list }], list: null }

const parseLine = (state: ParseState, rawLine: string): ParseState => {
	const line = rawLine.trim()
	if (line === "") return flushList(flushParagraph(state))
	const heading = HEADING_RE.exec(line)
	if (heading !== null) {
		const flushed = flushList(flushParagraph(state))
		return {
			...flushed,
			blocks: [
				...flushed.blocks,
				{ kind: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" },
			],
		}
	}
	const item = LIST_RE.exec(line) ?? ORDERED_LIST_RE.exec(line)
	if (item !== null) {
		const isOrdered = ORDERED_LIST_RE.test(line)
		const flushed = flushParagraph(state)
		const continued =
			flushed.list !== null && flushed.list.isOrdered === isOrdered
				? flushed
				: { ...flushList(flushed), list: null }
		const items = continued.list?.items ?? []
		return { ...continued, list: { isOrdered, items: [...items, item[1] ?? ""] } }
	}
	return { ...state, paragraph: [...state.paragraph, line] }
}

const HEADING_SIZES = ["text-lg", "text-base", "text-sm", "text-sm", "text-xs", "text-xs"]

const renderBlock = <M>(h: HtmlBuilder<M>, block: Block): Html => {
	switch (block.kind) {
		case "paragraph":
			return h.p([h.Class("leading-relaxed")], renderInline(h, block.text))
		case "heading": {
			const weight = block.level <= 2 ? "font-semibold" : "font-medium"
			return h.div(
				[h.Class(`${HEADING_SIZES[block.level - 1] ?? "text-xs"} ${weight} mt-2 first:mt-0`)],
				renderInline(h, block.text),
			)
		}
		case "list": {
			const className = `pl-5 ${block.isOrdered ? "list-decimal" : "list-disc"} space-y-0.5`
			const items = block.items.map((item) => h.li([], renderInline(h, item)))
			return block.isOrdered ? h.ol([h.Class(className)], items) : h.ul([h.Class(className)], items)
		}
	}
}

/** `renderMarkdown`: the note's blocks in order. */
export const renderMarkdown = <M>(h: HtmlBuilder<M>, content: string): ReadonlyArray<Html> => {
	const parsed = content
		.split(/\r?\n/)
		.reduce<ParseState>(parseLine, { blocks: [], paragraph: [], list: null })
	return flushList(flushParagraph(parsed)).blocks.map((block) => renderBlock(h, block))
}
