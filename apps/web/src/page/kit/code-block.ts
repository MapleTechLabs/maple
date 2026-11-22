import { highlightCode, type Lang } from "@maple/views/lib/highlight"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "@maple/views/ui/copy-button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { String as Str } from "effect"
import { hstack } from "@maple/views/ui/stack"

// A code block: language eyebrow, copy button, highlighted markup. The parent owns the copy status.

export type CodeBlockOptions<M> = Readonly<{
	code: string
	language?: string
	/** The language to highlight as, when the eyebrow is a label (`Helm`, `docker run`). */
	lang?: Lang
	className?: string
	/** The scrolling body's classes: a height cap for a long file keeps the copy button in view. */
	bodyClassName?: string
	/** The header's copy button; without both, the block is read-only and a sibling control copies it. */
	copy?: CopyButton.Model
	toCopyMessage?: (message: CopyButton.Message) => M
	/** Prose, not code (a prompt for a coding agent): shown as typed, without highlighting. */
	isPlain?: boolean
	/** A muted last line that is not part of `code`: a value shown masked until it is copied. */
	maskedLine?: string
}>

const escapeHtml = (text: string): string =>
	Str.replaceAll(">", "&gt;")(Str.replaceAll("<", "&lt;")(Str.replaceAll("&", "&amp;")(text)))

export const codeBlock = <M>(h: HtmlBuilder<M>, options: CodeBlockOptions<M>): Html => {
	const { copy, toCopyMessage } = options
	const header = [
		...(options.language === undefined ? [] : [eyebrow(h, { variant: "mono" }, [options.language])]),
		...(copy === undefined || toCopyMessage === undefined
			? []
			: [
					CopyButton.view(h, {
						model: copy,
						toParentMessage: toCopyMessage,
						value: options.code,
						label: "Code",
						className: "ml-auto",
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
				[h.Class(cn("overflow-x-auto bg-surface-well py-3", options.bodyClassName))],
				[
					// The padding sits on a content-wide `pre`, so a long line scrolls clear of the edge.
					h.pre(
						[
							h.Class(
								cn(
									"px-3 text-xs leading-relaxed",
									options.isPlain !== true && "w-max min-w-full",
								),
							),
						],
						[
							// Always markup, never a text child: tabs reuse this node across blocks, and
							// switching between the two kinds makes the patch remove a child that is gone.
							h.code(
								[
									...(options.isPlain === true ? [h.Class("whitespace-pre-wrap")] : []),
									h.InnerHTML(
										options.isPlain === true
											? escapeHtml(options.code)
											: highlightCode(
													options.code,
													options.lang ?? options.language ?? "",
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
		],
	)
}
