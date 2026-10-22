import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { COPY_PATH, DOWNLOAD_PATH, LINE_CLASS } from "../../kit/message-response"
import { type HighlightedCode, highlightKey } from "./code-highlight"

// Streamdown's full code block (`@streamdown/code`: Shiki tokens) and mermaid block
// (`@streamdown/mermaid`: the diagram, its toolbar and the zoom controls).
type OnMount<M> = Parameters<HtmlBuilder<M>["OnMount"]>[0]
export type DiagramFormat = "svg" | "png" | "mmd"

export type CodeHost<M> = Readonly<{
	highlights: Readonly<Record<string, HighlightedCode | null>>
	onCopy: (code: string) => M
	onDownload: (code: string, language: string) => M
	/** The open download menu (`inline:` / `fullscreen:` + source) and the fullscreen diagram. */
	diagramMenu: string | null
	fullscreenDiagram: string | null
	onToggleDiagramMenu: (menuId: string) => M
	onDiagramFormat: (menuId: string, code: string, format: DiagramFormat) => M
	onFullscreen: (code: string) => M
	onExitFullscreen: M
	/** `MountDiagramMenu` and `MountDiagramFullscreen` lifted to the host's Message. */
	diagramMenuMount: (menuId: string) => OnMount<M>
	fullscreenMount: OnMount<M>
	/** `MountMermaid({ code, isFullscreen })` lifted to the host's Message. */
	mermaidMount: (code: string, isFullscreen: boolean) => OnMount<M>
}>

const ZOOM_IN_PATH =
	"M1.5 6.5C1.5 3.73858 3.73858 1.5 6.5 1.5C9.26142 1.5 11.5 3.73858 11.5 6.5C11.5 9.26142 9.26142 11.5 6.5 11.5C3.73858 11.5 1.5 9.26142 1.5 6.5ZM6.5 0C2.91015 0 0 2.91015 0 6.5C0 10.0899 2.91015 13 6.5 13C8.02469 13 9.42677 12.475 10.5353 11.596L13.9697 15.0303L14.5 15.5607L15.5607 14.5L15.0303 13.9697L11.596 10.5353C12.475 9.42677 13 8.02469 13 6.5C13 2.91015 10.0899 0 6.5 0ZM4.125 5.875H4.75H5.875V4.75V4.125H7.125V4.75V5.875H8.25H8.875V7.125H8.25H7.125V8.25V8.875H5.875V8.25V7.125H4.75H4.125V5.875Z"
const ZOOM_OUT_PATH =
	"M1.5 6.5C1.5 3.73858 3.73858 1.5 6.5 1.5C9.26142 1.5 11.5 3.73858 11.5 6.5C11.5 9.26142 9.26142 11.5 6.5 11.5C3.73858 11.5 1.5 9.26142 1.5 6.5ZM6.5 0C2.91015 0 0 2.91015 0 6.5C0 10.0899 2.91015 13 6.5 13C8.02469 13 9.42677 12.475 10.5353 11.596L13.9697 15.0303L14.5 15.5607L15.5607 14.5L15.0303 13.9697L11.596 10.5353C12.475 9.42677 13 8.02469 13 6.5C13 2.91015 10.0899 0 6.5 0ZM4.125 5.875H4.75H8.25H8.875V7.125H8.25H4.75H4.125V5.875Z"
const RESET_PATH =
	"M13.5 8C13.5 4.96643 11.0257 2.5 7.96452 2.5C5.42843 2.5 3.29365 4.19393 2.63724 6.5H5.25H6V8H5.25H0.75C0.335787 8 0 7.66421 0 7.25V2.75V2H1.5V2.75V5.23347C2.57851 2.74164 5.06835 1 7.96452 1C11.8461 1 15 4.13001 15 8C15 11.87 11.8461 15 7.96452 15C5.62368 15 3.54872 13.8617 2.27046 12.1122L1.828 11.5066L3.03915 10.6217L3.48161 11.2273C4.48831 12.6051 6.12055 13.5 7.96452 13.5C11.0257 13.5 13.5 11.0336 13.5 8Z"
const FULLSCREEN_PATH =
	"M1 5.25V6H2.5V5.25V2.5H5.25H6V1H5.25H2C1.44772 1 1 1.44772 1 2V5.25ZM5.25 14.9994H6V13.4994H5.25H2.5V10.7494V9.99939H1V10.7494V13.9994C1 14.5517 1.44772 14.9994 2 14.9994H5.25ZM15 10V10.75V14C15 14.5523 14.5523 15 14 15H10.75H10V13.5H10.75H13.5V10.75V10H15ZM10.75 1H10V2.5H10.75H13.5V5.25V6H15V5.25V2C15 1.44772 14.5523 1 14 1H10.75Z"

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

const ZOOM_CLASS =
	"flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"

const zoomButton = <M>(
	h: HtmlBuilder<M>,
	label: string,
	d: string,
	slot: string,
	isResettable: boolean,
): Html =>
	h.button(
		[
			h.AriaLabel(label),
			h.Class(cn(ZOOM_CLASS, isResettable ? null : "disabled:cursor-not-allowed disabled:opacity-50")),
			h.DataAttribute("mermaid-control", slot),
			h.Title(label),
			h.Type("button"),
		],
		[glyph(h, d, "16")],
	)

/** A ```mermaid fence: its toolbar (download menu, copy, fullscreen) and the diagram. */
export const mermaidBlock = <M>(h: HtmlBuilder<M>, host: CodeHost<M>, code: string): Html =>
	h.div(
		[
			h.Class(
				"group relative my-4 flex w-full flex-col gap-2 rounded-xl border border-border bg-sidebar p-2 language-mermaid",
			),
			h.DataAttribute("streamdown", "mermaid-block"),
		],
		[
			h.div(
				[h.Class("flex h-8 items-center text-muted-foreground text-xs")],
				[h.span([h.Class("ml-1 font-mono lowercase")], ["mermaid"])],
			),
			actionsBar(h, "mermaid-block-actions", [
				diagramDownload(h, host, `inline:${code}`, code),
				action(h, "Copy Code", COPY_PATH, "code-block-copy-button", host.onCopy(code)),
				action(h, "View fullscreen", FULLSCREEN_PATH, null, host.onFullscreen(code)),
				...(host.fullscreenDiagram === code ? [fullscreenOverlay(h, host, code)] : []),
			]),
			h.div(
				[h.Class("overflow-hidden rounded-md border border-border bg-background")],
				[mermaidFrame(h, host, code, false)],
			),
		],
	)

/** The fullscreen dialog (portaled by its Mount): download, copy and exit over the fitted diagram. */
const fullscreenOverlay = <M>(h: HtmlBuilder<M>, host: CodeHost<M>, code: string): Html =>
	h.keyed("div")(
		"mermaid-fullscreen",
		[
			h.AriaLabel("View fullscreen"),
			h.Attribute("aria-modal", "true"),
			h.Class("fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm"),
			h.DataAttribute("streamdown", "mermaid-fullscreen"),
			h.Role("dialog"),
			h.OnMount(host.fullscreenMount),
		],
		[
			h.div(
				[h.Class("absolute top-4 right-4 z-10 flex items-center gap-1"), h.Role("presentation")],
				[
					diagramDownload(h, host, `fullscreen:${code}`, code),
					action(h, "Copy Code", COPY_PATH, "code-block-copy-button", host.onCopy(code)),
					h.button(
						[
							h.AriaLabel("Exit fullscreen"),
							h.Class(
								"rounded-md p-2 text-muted-foreground transition-all hover:bg-muted hover:text-foreground",
							),
							h.OnClick(host.onExitFullscreen),
							h.Title("Exit fullscreen"),
							h.Type("button"),
						],
						[glyph(h, XMARK_PATH, "20")],
					),
				],
			),
			h.div(
				[h.Class("flex size-full items-center justify-center p-4"), h.Role("presentation")],
				[mermaidFrame(h, host, code, true)],
			),
		],
	)

const FORMATS: ReadonlyArray<readonly [DiagramFormat, string]> = [
	["svg", "SVG"],
	["png", "PNG"],
	["mmd", "MMD"],
]

/** `ct`: Download opens a menu of formats under it; a press outside closes it. */
const diagramDownload = <M>(h: HtmlBuilder<M>, host: CodeHost<M>, menuId: string, code: string): Html =>
	h.div(
		[h.Class("relative")],
		[
			action(h, "Download diagram", DOWNLOAD_PATH, null, host.onToggleDiagramMenu(menuId)),
			...(host.diagramMenu !== menuId
				? []
				: [
						h.keyed("div")(
							`diagram-menu:${menuId}`,
							[
								h.Class(
									"absolute top-full right-0 z-10 mt-1 min-w-[120px] overflow-hidden rounded-md border border-border bg-background shadow-lg",
								),
								h.OnMount(host.diagramMenuMount(menuId)),
							],
							FORMATS.map(([format, label]) =>
								h.button(
									[
										h.AriaLabel(`Download diagram as ${label}`),
										h.Class(
											"w-full px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40",
										),
										h.OnClick(host.onDiagramFormat(menuId, code, format)),
										h.Title(`Download diagram as ${label}`),
										h.Type("button"),
									],
									[label],
								),
							),
						),
					]),
		],
	)

const XMARK_PATH =
	"M12.4697 13.5303L13 14.0607L14.0607 13L13.5303 12.4697L9.06065 7.99999L13.5303 3.53032L14.0607 2.99999L13 1.93933L12.4697 2.46966L7.99999 6.93933L3.53032 2.46966L2.99999 1.93933L1.93933 2.99999L2.46966 3.53032L6.93933 7.99999L2.46966 12.4697L1.93933 13L2.99999 14.0607L3.53032 13.5303L7.99999 9.06065L12.4697 13.5303Z"

const FULLSCREEN_SVG_CLASS = "size-full [&_svg]:h-auto [&_svg]:w-auto"

/** Streamdown's `Mermaid` (`ln`) + `PanZoom` (`Rr`): the frame mermaid draws into, inline or fullscreen. */
const mermaidFrame = <M>(h: HtmlBuilder<M>, host: CodeHost<M>, code: string, isFullscreen: boolean): Html =>
	h.div(
		[
			h.Class(isFullscreen ? cn("size-full", FULLSCREEN_SVG_CLASS) : "max-h-[min(70vh,40rem)] w-full"),
			h.DataAttribute("streamdown", "mermaid"),
		],
		[
			h.div(
				[
					h.Class(
						isFullscreen
							? cn(
									"relative flex flex-col",
									"h-full w-full",
									cn("size-full overflow-hidden", FULLSCREEN_SVG_CLASS),
								)
							: "relative flex flex-col min-h-28 w-full max-h-[min(70vh,40rem)] overflow-hidden",
					),
					h.Style({ cursor: "grab" }),
					h.OnMount(host.mermaidMount(code, isFullscreen)),
				],
				[
					h.div(
						[
							h.Class(
								cn(
									"absolute z-10 flex flex-col gap-1 rounded-md border border-border bg-background/80 p-1 supports-[backdrop-filter]:bg-background/70 supports-[backdrop-filter]:backdrop-blur-sm",
									isFullscreen ? "bottom-4 left-4" : "bottom-2 left-2",
								),
							),
						],
						[
							zoomButton(h, "Zoom in", ZOOM_IN_PATH, "in", false),
							zoomButton(h, "Zoom out", ZOOM_OUT_PATH, "out", false),
							zoomButton(h, "Reset zoom and pan", RESET_PATH, "reset", true),
						],
					),
					h.div(
						[
							h.Class(
								"flex h-full w-full flex-1 origin-center items-center justify-center transition-transform duration-150 ease-out",
							),
							h.Role("application"),
							h.Style({
								transform: "translate(0px, 0px) scale(1)",
								"transform-origin": "center center",
								"touch-action": "none",
								"will-change": "transform",
							}),
						],
						[
							h.div(
								[
									h.AriaLabel("Mermaid chart"),
									h.Class(
										cn("flex justify-center", isFullscreen && "size-full items-center"),
									),
									h.Role("img"),
								],
								[],
							),
						],
					),
				],
			),
		],
	)
