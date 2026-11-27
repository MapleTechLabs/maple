import { highlightCode, type Lang } from "@maple/views/lib/highlight"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "@maple/views/ui/copy-button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { Array as Arr, String as Str } from "effect"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { REPLAY_BLOCK_CLASS } from "./replay-privacy"

// A code block: language eyebrow or file name, copy button, highlighted markup. The parent owns the copy status.

/** A long file shown as its first lines until opened; Copy still writes all of it. */
export type CodeFold<M> = Readonly<{
	isOpen: boolean
	/** How many lines show while folded. A file only a few lines longer is never folded. */
	lines: number
	onToggle: M
}>

export type CodeBlockOptions<M> = Readonly<{
	code: string
	language?: string
	/** The file the code is saved as, in the header as typed (`maple.ts`) in place of the eyebrow. */
	fileName?: string
	/** The language to highlight as, when the eyebrow is a label (`Helm`, `docker run`). */
	lang?: Lang
	className?: string
	/** The scrolling body's classes: a height cap for a long file keeps the copy button in view. */
	bodyClassName?: string
	/** The header's copy button; without both, the block is read-only and a sibling control copies it. */
	copy?: CopyButton.Model
	toCopyMessage?: (message: CopyButton.Message) => M
	/** What Copy writes, when it differs from the code shown (a key masked on screen). */
	copyValue?: string
	/** Controls in the header, before the copy button (a reveal toggle). */
	actions?: ReadonlyArray<Html>
	/** Prose, not code (a prompt for a coding agent): shown as typed, without highlighting. */
	isPlain?: boolean
	/** A muted last line that is not part of `code`: a value shown masked until it is copied. */
	maskedLine?: string
	/** Wraps long lines. On by default for a one-line command with no file name, so it shows whole. */
	wrap?: boolean
	/** Holds a secret: session replay records the block as a placeholder. */
	secret?: boolean
	/** Makes the scrolling body a focusable region with this name, so the keyboard can scroll a long file. */
	scrollLabel?: string
	fold?: CodeFold<M>
}>

// Folding a file to save three lines or fewer only adds a click.
const FOLD_SLACK = 3

const escapeHtml = (text: string): string =>
	Str.replaceAll(">", "&gt;")(Str.replaceAll("<", "&lt;")(Str.replaceAll("&", "&amp;")(text)))

export const codeBlock = <M>(h: HtmlBuilder<M>, options: CodeBlockOptions<M>): Html => {
	const { copy, toCopyMessage, fold } = options
	const lines = Str.split("\n")(options.code)
	const isFoldable = fold !== undefined && lines.length > fold.lines + FOLD_SLACK
	const shown = isFoldable && !fold.isOpen ? Arr.join(Arr.take(lines, fold.lines), "\n") : options.code
	const isWrapped =
		options.isPlain === true ||
		(options.wrap ?? (options.fileName === undefined && !Str.includes("\n")(options.code)))
	const label =
		options.fileName !== undefined
			? [
					hstack(h, { gap: "1.5", align: "center", className: "min-w-0" }, [
						icon(h, "FileIcon", { size: 12, className: "shrink-0" }),
						typography(h, { size: "xs", mono: true, tone: "foreground", truncate: true }, [
							options.fileName,
						]),
					]),
				]
			: options.language !== undefined
				? [eyebrow(h, { variant: "mono" }, [options.language])]
				: []
	const header = [
		...label,
		...(options.actions === undefined
			? []
			: [hstack(h, { gap: "1", align: "center", className: "ml-auto" }, options.actions)]),
		...(copy === undefined || toCopyMessage === undefined
			? []
			: [
					CopyButton.view(h, {
						model: copy,
						toParentMessage: toCopyMessage,
						value: options.copyValue ?? options.code,
						label: "Code",
						className: options.actions === undefined ? "ml-auto" : undefined,
					}),
				]),
	]
	return h.div(
		[h.Class(cn("relative overflow-clip rounded-md border border-border bg-muted", options.className))],
		[
			...(header.length === 0
				? []
				: [
						hstack(
							h,
							{
								align: "center",
								justify: "between",
								className: "px-3 py-1.5 text-muted-foreground",
							},
							header,
						),
					]),
			h.div(
				[
					...(options.scrollLabel === undefined
						? []
						: [h.Tabindex(0), h.Role("region"), h.AriaLabel(options.scrollLabel)]),
					h.Class(
						cn(
							"overflow-x-auto bg-surface-well py-3",
							options.scrollLabel !== undefined &&
								"outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
							options.secret === true && REPLAY_BLOCK_CLASS,
							options.bodyClassName,
						),
					),
				],
				[
					// The padding sits on a content-wide `pre`, so a long line scrolls clear of the edge.
					h.pre(
						[h.Class(cn("px-3 text-xs leading-relaxed", !isWrapped && "w-max min-w-full"))],
						[
							// Always markup, never a text child: tabs reuse this node across blocks, and
							// switching between the two kinds makes the patch remove a child that is gone.
							h.code(
								[
									...(isWrapped ? [h.Class("whitespace-pre-wrap wrap-break-word")] : []),
									h.InnerHTML(
										options.isPlain === true
											? escapeHtml(shown)
											: highlightCode(
													shown,
													options.lang ??
														options.fileName ??
														options.language ??
														"",
												),
									),
								],
								[],
							),
						],
					),
					...(options.maskedLine === undefined
						? []
						: [
								h.pre(
									[
										h.Class(
											"px-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground",
										),
									],
									[options.maskedLine],
								),
							]),
				],
			),
			...(isFoldable
				? [
						hstack(h, { align: "center", className: "border-t border-border px-1.5 py-1" }, [
							button(
								h,
								{
									variant: "ghost",
									size: "xs",
									attributes: [h.AriaExpanded(fold.isOpen), h.OnClick(fold.onToggle)],
								},
								[
									icon(h, fold.isOpen ? "ChevronUpIcon" : "ChevronDownIcon", { size: 12 }),
									fold.isOpen ? "Show fewer lines" : `Show all ${lines.length} lines`,
								],
							),
						]),
					]
				: []),
		],
	)
}
