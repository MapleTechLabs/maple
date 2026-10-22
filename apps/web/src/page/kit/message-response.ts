import * as Markdown from "@foldkit/markdown"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"

// Lightweight markdown over Streamdown:
// laid out with Streamdown's element classes. The parser loads on first use, never at startup.
// TODO(markdown-table): Maple's `MarkdownTable` primitives are drawn with Streamdown's own table classes.

// The parse is the shared one (`page/kit/markdown`), re-exported for the pages that import it here.
export { ParsedMarkdown, parseMarkdownTexts } from "./markdown"

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

/** What a code block's two buttons ask the page for. */
export type CodeActions<M> = Readonly<{
	onCopy: (code: string) => M
	onDownload: (code: string, language: string) => M
	/** The code whose Copy shows its check, while Streamdown holds it. */
	copiedCode?: string | null
}>

export const DOWNLOAD_PATH =
	"M8.75 1V1.75V8.68934L10.7197 6.71967L11.25 6.18934L12.3107 7.25L11.7803 7.78033L8.70711 10.8536C8.31658 11.2441 7.68342 11.2441 7.29289 10.8536L4.21967 7.78033L3.68934 7.25L4.75 6.18934L5.28033 6.71967L7.25 8.68934V1.75V1H8.75ZM13.5 9.25V13.5H2.5V9.25V8.5H1V9.25V14C1 14.5523 1.44771 15 2 15H14C14.5523 15 15 14.5523 15 14V9.25V8.5H13.5V9.25Z"
export const CHECK_PATH =
	"M15.5607 3.99999L15.0303 4.53032L6.23744 13.3232C5.55403 14.0066 4.44599 14.0066 3.76257 13.3232L4.2929 12.7929L3.76257 13.3232L0.969676 10.5303L0.439346 9.99999L1.50001 8.93933L2.03034 9.46966L4.82323 12.2626C4.92086 12.3602 5.07915 12.3602 5.17678 12.2626L13.9697 3.46966L14.5 2.93933L15.5607 3.99999Z"
export const COPY_PATH =
	"M2.75 0.5C1.7835 0.5 1 1.2835 1 2.25V9.75C1 10.7165 1.7835 11.5 2.75 11.5H3.75H4.5V10H3.75H2.75C2.61193 10 2.5 9.88807 2.5 9.75V2.25C2.5 2.11193 2.61193 2 2.75 2H8.25C8.38807 2 8.5 2.11193 8.5 2.25V3H10V2.25C10 1.2835 9.2165 0.5 8.25 0.5H2.75ZM7.75 4.5C6.7835 4.5 6 5.2835 6 6.25V13.75C6 14.7165 6.7835 15.5 7.75 15.5H13.25C14.2165 15.5 15 14.7165 15 13.75V6.25C15 5.2835 14.2165 4.5 13.25 4.5H7.75ZM7.5 6.25C7.5 6.11193 7.61193 6 7.75 6H13.25C13.3881 6 13.5 6.11193 13.5 6.25V13.75C13.5 13.8881 13.3881 14 13.25 14H7.75C7.61193 14 7.5 13.8881 7.5 13.75V6.25Z"

export const glyph = <M>(h: HtmlBuilder<M>, d: string): Html =>
	h.svg(
		[
			h.AriaHidden(true),
			h.Attribute("color", "currentColor"),
			h.Attribute("height", "16"),
			h.Attribute("size", "14"),
			h.Attribute("stroke-linejoin", "round"),
			h.Attribute("viewBox", "0 0 16 16"),
			h.Attribute("width", "16"),
		],
		[
			h.path([
				h.Attribute("clip-rule", "evenodd"),
				h.Attribute("d", d),
				h.Attribute("fill", "currentColor"),
				h.Attribute("fill-rule", "evenodd"),
			]),
		],
	)

const codeAction = <M>(
	h: HtmlBuilder<M>,
	slot: string,
	label: string,
	d: string,
	onClick: M | undefined,
): Html =>
	h.button(
		[
			h.AriaLabel(label),
			h.Class(
				"cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
			),
			h.DataAttribute("streamdown", slot),
			h.Title(label),
			h.Type("button"),
			...(onClick === undefined ? [] : [h.OnClick(onClick)]),
		],
		[glyph(h, d)],
	)

export const LINE_CLASS =
	"block before:content-[counter(line)] before:inline-block before:[counter-increment:line] before:w-6 before:mr-4 before:text-[13px] before:text-right before:text-muted-foreground/50 before:font-mono before:select-none"
const TOKEN_CLASS =
	"text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))] bg-[var(--sdm-tbg)] dark:bg-[var(--shiki-dark-bg,var(--sdm-tbg))]"

/** Streamdown's code block without Shiki: the header, the copy and download actions, numbered lines. */
const codeBlock = <M>(
	h: HtmlBuilder<M>,
	value: string,
	language: string,
	actions: CodeActions<M> | undefined,
): Html => {
	const code = value.replace(/\n+$/, "")
	const isCopied = actions?.copiedCode === code
	return h.div(
		[
			h.Class(
				"relative my-4 flex w-full flex-col gap-2 rounded-xl border border-border bg-sidebar p-2",
			),
			h.DataAttribute("language", language),
			h.DataAttribute("streamdown", "code-block"),
			h.Attribute("dir", "ltr"),
			h.Style({ "content-visibility": "auto", "contain-intrinsic-size": "auto 200px" }),
		],
		[
			h.div(
				[
					h.Class("flex h-8 items-center text-muted-foreground text-xs"),
					h.DataAttribute("language", language),
					h.DataAttribute("streamdown", "code-block-header"),
				],
				[h.span([h.Class("ml-1 font-mono lowercase")], [language])],
			),
			h.div(
				[h.Class("pointer-events-none absolute top-2 right-2 z-10 flex items-center")],
				[
					h.div(
						[
							h.Class(
								"pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur",
							),
							h.DataAttribute("streamdown", "code-block-actions"),
						],
						[
							codeAction(
								h,
								"code-block-download-button",
								"Download file",
								DOWNLOAD_PATH,
								actions?.onDownload(code, language),
							),
							codeAction(
								h,
								"code-block-copy-button",
								"Copy Code",
								isCopied ? CHECK_PATH : COPY_PATH,
								actions?.onCopy(code),
							),
							...(isCopied
								? [h.output([h.AriaLive("polite"), h.Class("sr-only")], ["Copied"])]
								: []),
						],
					),
				],
			),
			h.div(
				[
					h.Class(
						"overflow-y-auto overflow-x-auto rounded-md border border-border bg-background p-4 text-sm",
					),
					h.DataAttribute("language", language),
					h.DataAttribute("streamdown", "code-block-body"),
					h.Style({ "max-height": "400px" }),
				],
				[
					h.pre(
						[
							h.Class(
								"bg-[var(--sdm-bg,inherit)] dark:bg-[var(--shiki-dark-bg,var(--sdm-bg,inherit))]",
							),
							h.Style({ "--sdm-bg": "transparent", "--sdm-fg": "inherit" }),
						],
						[
							h.code(
								[h.Class("[counter-increment:line_0] [counter-reset:line]")],
								code.split("\n").map((line) =>
									h.span(
										[h.Class(LINE_CLASS)],
										[
											h.span(
												[
													h.Class(TOKEN_CLASS),
													h.Style({
														"--sdm-c": "inherit",
														"--sdm-tbg": "transparent",
													}),
												],
												[line],
											),
										],
									),
								),
							),
						],
					),
				],
			),
		],
	)
}

/** A surface's own element views over Streamdown's (the chat's tables and chart fences). */
export type ViewOverrides = (views: Markdown.Views) => Partial<Markdown.Views>

const markdownLink = <M>(h: HtmlBuilder<M>, url: string, content: ReadonlyArray<Html | string>): Html =>
	h.a(
		[
			...streamdown("link", "wrap-anywhere font-medium text-primary underline")(h),
			h.Href(url),
			h.Attribute("rel", "noreferrer"),
			h.Attribute("target", "_blank"),
		],
		content,
	)

const imageLabel = (url: string, alt: string): string => (alt.trim() === "" ? url : alt)

// Model output and transcripts are untrusted: an image is a link the reader opens, never a fetch.
const markdownImage = <M>(h: HtmlBuilder<M>, url: string, alt: string): Html =>
	markdownLink(h, url, [imageLabel(url, alt)])

const viewsFor = <M>(
	h: HtmlBuilder<M>,
	actions?: CodeActions<M>,
	overrides?: ViewOverrides,
): Markdown.Views => {
	const views: Markdown.Views = {
		...Markdown.defaultViews,
		InlineCode: ({ value }) =>
			h.code(streamdown("inline-code", "rounded bg-muted px-1.5 py-0.5 font-mono text-sm")(h), [value]),
		Strong: (_strong, content) => h.span(streamdown("strong", "font-semibold")(h), content),
		// A linked image is the outer link's label: no anchor inside an anchor.
		Link: (link, content) =>
			markdownLink(
				h,
				link.url,
				link.content.some((inline) => inline._tag === "Image")
					? Markdown.viewBlocks(
							{ blocks: [{ _tag: "Paragraph", content: link.content }] },
							{
								views: {
									...viewsFor(h, actions, overrides),
									Paragraph: (_paragraph, inline) => h.span([], inline),
									Image: ({ url, alt }) => h.span([], [imageLabel(url, alt)]),
								},
							},
						)
					: content,
			),
		Image: ({ url, alt }) => markdownImage(h, url, alt),
		Heading: ({ level }, content) => {
			const attributes = streamdown(`heading-${level}`, HEADING_CLASSES[level])(h)
			if (level === 1) return h.h1(attributes, content)
			if (level === 2) return h.h2(attributes, content)
			if (level === 3) return h.h3(attributes, content)
			if (level === 4) return h.h4(attributes, content)
			return level === 5 ? h.h5(attributes, content) : h.h6(attributes, content)
		},
		CodeBlock: ({ value, maybeLanguage }) =>
			codeBlock(
				h,
				value,
				Option.getOrElse(maybeLanguage, () => ""),
				actions,
			),
		List: ({ isOrdered }, items) =>
			isOrdered
				? h.ol(
						streamdown(
							"ordered-list",
							"list-inside list-decimal whitespace-normal [li_&]:pl-6",
						)(h),
						items,
					)
				: h.ul(
						streamdown(
							"unordered-list",
							"list-inside list-disc whitespace-normal [li_&]:pl-6",
						)(h),
						items,
					),
		// Streamdown unwraps an item's lone paragraph; its inline content sits in a span here.
		ListItem: (item, blocks) =>
			h.li(
				streamdown("list-item", "py-1 [&>p]:inline")(h),
				item.blocks.length === 1 && item.blocks[0]?._tag === "Paragraph"
					? Markdown.viewBlocks(
							{ blocks: item.blocks },
							{
								views: {
									...viewsFor(h, actions, overrides),
									Paragraph: (_paragraph, content) => h.span([], content),
								},
							},
						)
					: blocks,
			),
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
	}
	return overrides === undefined ? views : { ...views, ...overrides(views) }
}

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
	actions?: CodeActions<M>,
	overrides?: ViewOverrides,
): Html =>
	h.div(
		[h.Class(cn(ROOT_CLASS, className))],
		document === null
			? text
					.split(/\n{2,}/)
					.filter((part) => part.trim() !== "")
					.map((part) => h.p([], [part]))
			: Markdown.viewBlocks(document, { views: viewsFor(h, actions, overrides) }),
	)
