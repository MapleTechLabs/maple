import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { COPY_PATH, DOWNLOAD_PATH, LINE_CLASS } from "../../kit/message-response"
import { type HighlightedCode, highlightKey } from "./code-highlight"

// Streamdown's full code block (`@streamdown/code`: Shiki tokens).

export type CodeHost<M> = Readonly<{
	highlights: Readonly<Record<string, HighlightedCode | null>>
	onCopy: (code: string) => M
	onDownload: (code: string, language: string) => M
}>

const glyph = <M>(h: HtmlBuilder<M>, d: string, size: string): Html =>
	h.svg(
		[
			h.AriaHidden(true),
			h.Attribute("color", "currentColor"),
			h.Attribute("height", "16"),
			h.Attribute("size", size),
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

const ACTION_CLASS =
	"cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"

const action = <M>(
	h: HtmlBuilder<M>,
	label: string,
	d: string,
	slot: string | null,
	onClick: M | null,
): Html =>
	h.button(
		[
			h.AriaLabel(label),
			h.Class(ACTION_CLASS),
			...(slot === null ? [] : [h.DataAttribute("streamdown", slot)]),
			h.Title(label),
			h.Type("button"),
			...(onClick === null ? [] : [h.OnClick(onClick)]),
		],
		[glyph(h, d, "14")],
	)

const actionsBar = <M>(h: HtmlBuilder<M>, slot: string, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.Class("pointer-events-none absolute top-2 right-2 z-10 flex items-center")],
		[
			h.div(
				[
					h.Class(
						"pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur",
					),
					h.DataAttribute("streamdown", slot),
				],
				children,
			),
		],
	)

const TOKEN_CLASS = "text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]"
const TOKEN_FILL_CLASS = "bg-[var(--sdm-tbg)] dark:bg-[var(--shiki-dark-bg,var(--sdm-tbg))]"

const codeLines = <M>(
	h: HtmlBuilder<M>,
	code: string,
	highlighted: HighlightedCode | null,
): ReadonlyArray<Html> =>
	highlighted === null
		? code
				.split("\n")
				.map((line) =>
					h.span(
						[h.Class(LINE_CLASS)],
						[
							h.span(
								[
									h.Class(cn(TOKEN_CLASS, TOKEN_FILL_CLASS)),
									h.Style({ "--sdm-c": "inherit", "--sdm-tbg": "transparent" }),
								],
								[line],
							),
						],
					),
				)
		: highlighted.lines.map((line) =>
				h.span(
					[h.Class(LINE_CLASS)],
					line.length === 0 || (line.length === 1 && line[0]?.content === "")
						? ["\n"]
						: line.map((token) =>
								h.span(
									[
										h.Class(cn(TOKEN_CLASS, token.hasBackground && TOKEN_FILL_CLASS)),
										h.Style(Object.fromEntries(token.style)),
									],
									[token.content],
								),
							),
				),
			)

/** A fenced block: the language header, Download and Copy, numbered lines (Shiki once it answered). */
export const codeBlock = <M>(h: HtmlBuilder<M>, host: CodeHost<M>, value: string, language: string): Html => {
	const code = value.replace(/\n+$/, "")
	const highlighted = host.highlights[highlightKey(language, value)] ?? null
	const languageClass = highlighted === null ? undefined : `language-${language}`
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
			actionsBar(h, "code-block-actions", [
				action(
					h,
					"Download file",
					DOWNLOAD_PATH,
					"code-block-download-button",
					host.onDownload(code, language),
				),
				action(h, "Copy Code", COPY_PATH, "code-block-copy-button", host.onCopy(code)),
			]),
			h.div(
				[
					h.Class(
						cn(
							languageClass,
							"overflow-y-auto overflow-x-auto rounded-md border border-border bg-background p-4 text-sm",
						),
					),
					h.DataAttribute("language", language),
					h.DataAttribute("streamdown", "code-block-body"),
					h.Style({ "max-height": "400px" }),
				],
				[
					h.pre(
						[
							h.Class(
								cn(
									languageClass,
									"bg-[var(--sdm-bg,inherit)] dark:bg-[var(--shiki-dark-bg,var(--sdm-bg,inherit))]",
								),
							),
							h.Style({ "--sdm-bg": "transparent", "--sdm-fg": "inherit" }),
						],
						[
							h.code(
								[h.Class("[counter-increment:line_0] [counter-reset:line]")],
								codeLines(h, code, highlighted),
							),
						],
					),
				],
			),
		],
	)
}
