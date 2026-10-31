import { highlightCode, type Lang, resolveLang } from "../../../lib/highlight"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "../../../ui/copy-button"
import { eyebrow } from "../../../ui/eyebrow"

// `CodeBlock`: language eyebrow, copy button, highlighted markup. The parent owns the copy status.

export type CodeBlockOptions<M> = Readonly<{
	code: string
	language?: string
	/** The language to highlight as, when the eyebrow is a label (`Helm`, `docker run`). */
	lang?: Lang
	className?: string
	/** The scrolling body's classes: a height cap for a long file keeps the copy button in view. */
	bodyClassName?: string
	copy: CopyButton.Model
	toCopyMessage: (message: CopyButton.Message) => M
	/** Prose, not code (a prompt for a coding agent): shown as typed, without highlighting. */
	isPlain?: boolean
}>

const escapeHtml = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export const codeBlock = <M>(h: HtmlBuilder<M>, options: CodeBlockOptions<M>): Html =>
	h.div(
		[h.Class(cn("relative overflow-clip rounded-md border border-border bg-muted", options.className))],
		[
			h.div(
				[h.Class("flex items-center justify-between px-3 py-1.5 text-muted-foreground")],
				[
					...(options.language === undefined ? [] : [eyebrow(h, {}, [options.language])]),
					CopyButton.view(h, {
						model: options.copy,
						toParentMessage: options.toCopyMessage,
						value: options.code,
						label: "Code",
						className: "ml-auto",
					}),
				],
			),
			h.div(
				[h.Class(cn("overflow-x-auto bg-background/50 py-3", options.bodyClassName))],
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
													options.lang ?? resolveLang(options.language ?? ""),
												),
									),
								],
								[],
							),
						],
					),
				],
			),
		],
	)
