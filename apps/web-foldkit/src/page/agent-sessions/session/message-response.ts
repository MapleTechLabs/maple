import * as Markdown from "@foldkit/markdown"
import { cn } from "@maple/ui/lib/utils"
import { Effect, Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"

// `MessageResponse lightweight` (components/ai-elements/message-response.tsx over Streamdown): markdown
// laid out with Streamdown's element classes. The parser loads on first use, never at startup.
// TODO(markdown-code): Streamdown's code block header and copy/download actions are drawn as a plain block.
// TODO(markdown-table): Maple's `MarkdownTable` primitives are drawn with Streamdown's own table classes.

/** A parsed body; `null` when the text holds a construct the vocabulary rejects (raw HTML). */
export const ParsedMarkdown = Schema.Struct({
	text: Schema.String,
	document: Schema.NullOr(Markdown.MarkdownDocument),
})
export type ParsedMarkdown = typeof ParsedMarkdown.Type

/** Parses each text with the lazily imported remark pipeline; a rejected text parses to `null`. */
export const parseMarkdownTexts = (texts: ReadonlyArray<string>) =>
	Effect.promise(() => import("@foldkit/markdown/vite")).pipe(
		Effect.flatMap(({ parseMarkdown }) =>
			Effect.forEach(texts, (text) =>
				Effect.try(() => parseMarkdown(text)).pipe(
					Effect.map((document): ParsedMarkdown => ({ text, document })),
					Effect.orElseSucceed((): ParsedMarkdown => ({ text, document: null })),
				),
			),
		),
	)

const streamdown =
	(slot: string, className: string) =>
	<M>(h: HtmlBuilder<M>) => [h.Class(className), h.DataAttribute("streamdown", slot)]

const HEADING_CLASSES = {
	1: "mt-6 mb-2 font-semibold text-3xl",
	2: "mt-6 mb-2 font-semibold text-2xl",
	3: "mt-6 mb-2 font-semibold text-xl",
	4: "mt-6 mb-2 font-semibold text-lg",
	5: "mt-6 mb-2 font-semibold text-base",
	6: "mt-6 mb-2 font-semibold text-sm",
} as const

const viewsFor = <M>(h: HtmlBuilder<M>): Markdown.Views => ({
	...Markdown.defaultViews,
	InlineCode: ({ value }) =>
		h.code(streamdown("inline-code", "rounded bg-muted px-1.5 py-0.5 font-mono text-sm")(h), [value]),
	Strong: (_strong, content) => h.span(streamdown("strong", "font-semibold")(h), content),
	Link: ({ url }, content) =>
		h.a(
			[
				...streamdown("link", "wrap-anywhere font-medium text-primary underline")(h),
				h.Href(url),
				h.Attribute("rel", "noreferrer"),
				h.Attribute("target", "_blank"),
			],
			content,
		),
	Heading: ({ level }, content) => {
		const attributes = streamdown(`heading-${level}`, HEADING_CLASSES[level])(h)
		if (level === 1) return h.h1(attributes, content)
		if (level === 2) return h.h2(attributes, content)
		if (level === 3) return h.h3(attributes, content)
		if (level === 4) return h.h4(attributes, content)
		return level === 5 ? h.h5(attributes, content) : h.h6(attributes, content)
	},
	CodeBlock: ({ value, maybeLanguage }) =>
		h.div(
			[
				...streamdown(
					"code-block",
					"relative my-4 flex w-full flex-col gap-2 rounded-xl border border-border bg-sidebar p-2",
				)(h),
				h.DataAttribute(
					"language",
					Option.getOrElse(maybeLanguage, () => ""),
				),
			],
			[
				h.div(
					streamdown(
						"code-block-body",
						"overflow-x-auto rounded-md border border-border bg-background p-4 text-sm",
					)(h),
					[h.pre([], [h.code([], [value])])],
				),
			],
		),
	List: ({ isOrdered }, items) =>
		isOrdered
			? h.ol(
					streamdown("ordered-list", "list-inside list-decimal whitespace-normal [li_&]:pl-6")(h),
					items,
				)
			: h.ul(
					streamdown("unordered-list", "list-inside list-disc whitespace-normal [li_&]:pl-6")(h),
					items,
				),
	ListItem: (_item, blocks) => h.li(streamdown("list-item", "py-1 [&>p]:inline")(h), blocks),
	Blockquote: (_quote, blocks) =>
		h.blockquote(
			streamdown(
				"blockquote",
				"my-4 border-muted-foreground/30 border-l-4 pl-4 text-muted-foreground italic",
			)(h),
			blocks,
		),
	ThematicBreak: () => h.hr(streamdown("horizontal-rule", "my-6 border-border")(h)),
	Table: (_table, headerRow, bodyRows) =>
		h.div(
			[h.DataAttribute("streamdown", "table-wrapper")],
			[
				h.table(streamdown("table", "w-full border-collapse border border-border")(h), [
					h.thead(streamdown("table-header", "bg-muted/80")(h), [headerRow]),
					h.tbody(streamdown("table-body", "divide-y divide-border")(h), bodyRows),
				]),
			],
		),
	TableRow: (_row, cells) => h.tr(streamdown("table-row", "border-border")(h), cells),
	TableCell: (_cell, content, _alignment, isHeader) =>
		isHeader
			? h.th(
					streamdown(
						"table-header-cell",
						"whitespace-nowrap px-4 py-2 text-left font-semibold text-sm",
					)(h),
					content,
				)
			: h.td(streamdown("table-cell", "px-4 py-2 text-sm")(h), content),
})

/** The Streamdown root: its spacing, then the panel's heading scale, then the caller's prose classes. */
const ROOT_CLASS = cn(
	"space-y-4 whitespace-normal",
	"size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
	"[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm",
	"[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold",
	"[&_h1]:mt-4 [&_h2]:mt-4 [&_h3]:mt-4 [&_h4]:mt-4 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_h4]:mb-1",
)

/** The laid-out body; before the parse lands (or for a rejected text) its paragraphs as plain text. */
export const messageResponse = <M>(
	h: HtmlBuilder<M>,
	document: Markdown.MarkdownDocument | null,
	text: string,
	className?: string,
): Html =>
	h.div(
		[h.Class(cn(ROOT_CLASS, className))],
		document === null
			? text
					.split(/\n{2,}/)
					.filter((part) => part.trim() !== "")
					.map((part) => h.p([], [part]))
			: Markdown.viewBlocks(document, { views: viewsFor(h) }),
	)
