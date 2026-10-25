import { JSON_TOKEN_COLOR, parseErrorBody, splitErrorText, tokenizeJson } from "@maple/ui/lib/error-body"
import { cn } from "@maple/ui/lib/utils"
import { capForDisplay, headLines, memoizeByText, PREVIEW_MAX_CHARS } from "../lib/display-text"
import { HIGHLIGHT_MAX_CHARS } from "../lib/sugar-high"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { copyButton, type CopyStatus } from "./copy-button"
import { eyebrow } from "./eyebrow"
import { icon } from "./icon"
import { truncationNote } from "./logs/log-message"

// Port of `ErrorSection` (packages/ui/src/components/error-section.tsx): the error banner, its
// highlighted body that copies itself, the "Copy as prompt" control and the Show more toggle.

const COLLAPSED_LINES = 3
const LINE_HEIGHT = 1.625

const parsedErrorBody = memoizeByText(parseErrorBody)

export type ErrorSectionOptions<M> = Readonly<{
	message: string
	/** Banner heading; "Fatal" for fatal-severity logs. */
	title?: string
	/** `exception.type`, beside the title. */
	badge?: string
	isExpanded: boolean
	onToggle: M
	bodyStatus: CopyStatus
	onCopyBody: M
	/** The "Copy as prompt" control, when the caller gives one. `trigger`: a live Tooltip's trigger attributes. */
	prompt?: Readonly<{
		status: CopyStatus
		onCopy: M
		tooltipId?: string
		trigger?: ReadonlyArray<ChildAttribute>
	}>
}>

export const errorSectionView = <M>(h: HtmlBuilder<M>, options: ErrorSectionOptions<M>): Html => {
	const { message } = options
	const body = parsedErrorBody(message)
	const isLong = body.full.split("\n", COLLAPSED_LINES + 1).length > COLLAPSED_LINES || message.length > 160
	const isClamped = isLong && !options.isExpanded
	// Clamped, only the lines that show are built; expanded, a capped head scrolls in its own box.
	const { shown, omitted } = isClamped
		? capForDisplay(headLines(body.full, COLLAPSED_LINES + 1), PREVIEW_MAX_CHARS)
		: capForDisplay(body.full)
	const { prompt } = options
	return h.div(
		[h.Class("mx-3 my-2 rounded-lg border border-severity-error/25 bg-severity-error/4 px-3 py-2.5")],
		[
			h.div(
				[h.Class("flex min-w-0 items-center gap-2")],
				[
					icon(h, "CircleWarningIcon", { size: 14, className: "shrink-0 text-severity-error" }),
					eyebrow(h, { variant: "label", className: "shrink-0 text-severity-error" }, [
						options.title ?? "Error",
					]),
					...(options.badge
						? [
								h.span(
									[
										h.Class("min-w-0 truncate font-mono text-2xs text-foreground/80"),
										h.Title(options.badge),
									],
									[options.badge],
								),
							]
						: []),
					...(body.format === "json"
						? [
								h.span(
									[
										h.Class(
											"flex shrink-0 items-center gap-1 rounded border border-severity-error/25 px-1 py-px font-mono text-4xs text-severity-error/70 uppercase",
										),
										h.Title("JSON payload"),
									],
									[icon(h, "BracketsCurlyIcon", { size: 9 }), "json"],
								),
							]
						: []),
					...(prompt === undefined
						? []
						: [
								copyButton(h, {
									status: prompt.status,
									label: "error as an AI prompt",
									iconSize: 12,
									idleIcon: "SparkleIcon",
									className:
										"ml-auto size-5 shrink-0 rounded text-severity-error/70 hover:bg-severity-error/10 hover:text-severity-error sm:size-5",
									slot:
										prompt.tooltipId === undefined && prompt.trigger === undefined
											? undefined
											: "tooltip-trigger",
									attributes: [
										...(prompt.trigger ??
											(prompt.tooltipId === undefined
												? []
												: [
														h.DataAttribute("base-ui-tooltip-trigger", ""),
														h.Id(prompt.tooltipId),
													])),
										h.OnClick(prompt.onCopy, { propagation: "Stop" }),
									],
								}),
							]),
				],
			),
			h.button(
				[
					h.AriaLabel("Copy error message"),
					h.Class(
						cn(
							"mt-1.5 block w-full cursor-copy rounded text-left font-mono text-2xs text-foreground/90 leading-relaxed",
							"transition-colors duration-150 hover:text-foreground motion-reduce:transition-none",
							"data-[copy-status=copied]:text-severity-info",
						),
					),
					h.DataAttribute("copy-status", options.bodyStatus),
					h.Title("Click to copy"),
					h.Type("button"),
					h.OnClick(options.onCopyBody),
				],
				[
					h.pre(
						[
							h.Class(
								cn(
									"whitespace-pre-wrap break-words",
									isLong && options.isExpanded && "max-h-[45vh] overflow-auto",
									isClamped &&
										"overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-1.25em),transparent)]",
								),
							),
							...(isClamped
								? [h.Style({ "max-height": `${COLLAPSED_LINES * LINE_HEIGHT}em` })]
								: []),
						],
						shown.length > HIGHLIGHT_MAX_CHARS
							? [shown]
							: body.format === "json"
								? tokenizeJson(shown).map((token) =>
										h.span(
											[h.Style({ color: JSON_TOKEN_COLOR[token.type] })],
											[token.text],
										),
									)
								: splitErrorText(shown).map((line) =>
										h.span(
											[h.Class(cn("block", line.frame && "text-severity-error/55"))],
											[line.text === "" ? " " : line.text],
										),
									),
					),
				],
			),
			...(omitted === 0 || isClamped ? [] : [truncationNote(h, shown.length, body.full.length)]),
			...(isLong
				? [
						h.button(
							[
								h.AriaExpanded(options.isExpanded),
								h.Class(
									"mt-1 rounded text-2xs text-severity-error/70 hover:text-severity-error",
								),
								h.Type("button"),
								h.OnClick(options.onToggle),
							],
							[options.isExpanded ? "Show less" : "Show more"],
						),
					]
				: []),
		],
	)
}
