import { JSON_TOKEN_COLOR, parseErrorBody, splitErrorText, tokenizeJson } from "@maple/ui/lib/error-body"
import { formatErrorPrompt } from "@maple/ui/lib/error-prompt"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../../ui/eyebrow"
import { icon } from "../../../../ui/icon"
import { copyButton, statusOf } from "./copy"
import { Message } from "./message"
import type { PanelState as Model } from "./model"

// `ErrorSection` (packages/ui/src/components/error-section.tsx), with a "Copy as prompt" payload.

/** Any builder whose Messages include the panel's: the panel's own, the popover's, local-ui's. */
type H<P> = HtmlBuilder<Message | P>

const COLLAPSED_LINES = 3
const LINE_HEIGHT = 1.625

export type ErrorSectionInput = Readonly<{
	message: string
	prompt: Readonly<{ serviceName: string; operation: string; attributes: Readonly<Record<string, string>> }>
	/** A short tag beside the title (the agent popover's `error.type`). */
	badge?: string
	className?: string
}>

const BODY_ID = "error-body"

export const errorSection = <P>(h: H<P>, model: Model, input: ErrorSectionInput): Html => {
	const { message } = input
	const body = parseErrorBody(message)
	const isLong = body.full.split("\n").length > COLLAPSED_LINES || message.length > 160
	const isClamped = isLong && !model.isErrorExpanded
	const status = statusOf(model, BODY_ID)
	return h.div(
		[
			h.Class(
				cn(
					"mx-3 my-2 rounded-lg border border-severity-error/25 bg-severity-error/4 px-3 py-2.5",
					input.className,
				),
			),
		],
		[
			h.div(
				[h.Class("flex min-w-0 items-center gap-2")],
				[
					icon(h, "CircleWarningIcon", { size: 14, className: "shrink-0 text-severity-error" }),
					eyebrow(h, { variant: "label", className: "shrink-0 text-severity-error" }, ["Error"]),
					...(input.badge === undefined || input.badge === ""
						? []
						: [
								h.span(
									[
										h.Class("min-w-0 truncate font-mono text-2xs text-foreground/80"),
										h.Title(input.badge),
									],
									[input.badge],
								),
							]),
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
					copyButton(h, model, {
						id: "error-prompt",
						value: formatErrorPrompt({
							message,
							serviceName: input.prompt.serviceName,
							operation: input.prompt.operation,
							attributes: { ...input.prompt.attributes },
						}),
						label: "error as an AI prompt",
						idleIcon: "SparkleIcon",
						iconSize: 12,
						tooltipId: "span-panel-error-prompt",
						className:
							"ml-auto size-5 shrink-0 rounded text-severity-error/70 hover:bg-severity-error/10 hover:text-severity-error sm:size-5",
					}),
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
					h.DataAttribute("copy-status", status),
					h.Title("Click to copy"),
					h.Type("button"),
					h.OnClick(Message.ClickedCopy({ id: BODY_ID, text: body.full })),
				],
				[
					h.pre(
						[
							h.Class(
								cn(
									"whitespace-pre-wrap break-words",
									isClamped &&
										"overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%-1.25em),transparent)]",
								),
							),
							...(isClamped
								? [h.Style({ "max-height": `${COLLAPSED_LINES * LINE_HEIGHT}em` })]
								: []),
						],
						body.format === "json"
							? tokenizeJson(body.full).map((token) =>
									h.span([h.Style({ color: JSON_TOKEN_COLOR[token.type] })], [token.text]),
								)
							: splitErrorText(body.full).map((line) =>
									h.span(
										[h.Class(cn("block", line.frame && "text-severity-error/55"))],
										[line.text === "" ? " " : line.text],
									),
								),
					),
				],
			),
			...(isLong
				? [
						h.button(
							[
								h.AriaExpanded(model.isErrorExpanded),
								h.Class(
									"mt-1 rounded text-2xs text-severity-error/70 hover:text-severity-error",
								),
								h.Type("button"),
								h.OnClick(Message.ToggledErrorExpanded()),
							],
							[model.isErrorExpanded ? "Show less" : "Show more"],
						),
					]
				: []),
		],
	)
}
