import { formatBytes, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	type PayloadLine,
	parsePayload,
	payloadLines,
	payloadLinesBytes,
	unwrapToolErrorText,
	whatsWrong,
} from "../../../lib/agent-sessions/tool-error-display"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { statusDot } from "../../../ui/status-dot"
import { Message, type Model, type ToolErrorOccurrenceRow } from "./error-modal-model"

// `SampleBody` of `ToolErrorModal`: what the call was handed and what it gave back, and where the
// arguments confirm a schema failure, what is wrong with them.

type H = HtmlBuilder<Message>

const payloadHead = (
	h: H,
	options: Readonly<{ label: string; attribute: string; bytes: number; action?: Html }>,
): Html =>
	h.div(
		[h.Class("flex items-center gap-2 font-mono leading-3.5")],
		[
			eyebrow(h, { variant: "mono" }, [options.label]),
			h.span(
				[h.Class("truncate text-2xs text-foreground-faint")],
				[options.attribute, ...(options.bytes > 0 ? [` · ${formatBytes(options.bytes)}`] : [])],
			),
			h.span([h.Class("grow")], []),
			...(options.action === undefined ? [] : [options.action]),
		],
	)

const notRecorded = (h: H, what: "arguments" | "result"): Html =>
	h.div(
		[h.Class("flex flex-col gap-1 rounded-md border border-dashed border-input p-3.5 font-mono")],
		[
			h.span([h.Class("text-xs text-muted-foreground")], ["Not recorded"]),
			h.span(
				[h.Class("text-2xs leading-[15px] text-foreground-subtle")],
				["The span has no ", what, " attribute."],
			),
		],
	)

const payloadLineView = (h: H, line: PayloadLine): Html =>
	h.div(
		[
			h.Class(
				cn("pr-3.5", line.highlight && "border-l-2 border-l-severity-error bg-severity-error-a2"),
			),
			h.Style({ "padding-left": `${14 + line.depth * 16 - (line.highlight ? 2 : 0)}px` }),
		],
		[
			line.missingKey !== undefined
				? h.span(
						[
							h.Class(
								"my-0.5 inline-flex items-center gap-2 rounded-xs border border-dashed border-severity-error/60 px-1.5 text-2xs leading-4 text-severity-error",
							),
						],
						['"', line.missingKey, '"', h.span([h.Class("opacity-80")], ["missing, required"])],
					)
				: h.span(
						[
							h.Class(
								cn(
									"whitespace-pre-wrap break-words",
									line.highlight
										? "text-foreground"
										: line.folded !== undefined
											? "text-muted-foreground"
											: "text-foreground-soft",
								),
							),
						],
						[line.text],
					),
			...(line.folded === undefined
				? []
				: [
						h.span(
							[h.Class("ml-2 rounded-xs bg-muted px-1 text-2xs text-muted-foreground")],
							[line.folded],
						),
					]),
			...(line.note === undefined
				? []
				: [
						h.div(
							[h.Class("flex items-center gap-2.5 pb-1 text-2xs leading-3.5")],
							[
								h.span([h.Class("text-severity-error")], ["↑ ", line.note.text]),
								...(line.note.hiddenBytes > 0
									? [
											h.span(
												[
													h.Class(
														"rounded-xs bg-muted px-1 text-2xs text-muted-foreground",
													),
												],
												["+", formatBytes(line.note.hiddenBytes), " not shown"],
											),
										]
									: []),
							],
						),
					]),
		],
	)

const utf8Length = (text: string) => new TextEncoder().encode(text).length

/** The arguments shortened around the error path; "Show full payload" is everything the read carries. */
const argumentsBlock = (
	h: H,
	model: Model,
	row: ToolErrorOccurrenceRow,
	message: string,
	args: unknown,
): Html => {
	if (row.arguments === "")
		return h.div(
			[h.Class("flex w-0 min-w-0 grow flex-col gap-2 max-lg:w-full")],
			[
				payloadHead(h, { label: "Arguments", attribute: "gen_ai.tool.call.arguments", bytes: 0 }),
				notRecorded(h, "arguments"),
			],
		)
	const lines = args === undefined ? undefined : payloadLines(args, message)
	const isFull = model.isFullArguments
	const isTruncatedByRead = row.argumentsBytes > utf8Length(row.arguments)
	const copyLabel =
		model.argumentsCopy === "failed"
			? "Copy failed"
			: model.argumentsCopy === "copied"
				? "Copied"
				: "Copy"
	const note = isTruncatedByRead
		? `The first ${formatNumber(row.arguments.length)} characters of ${formatBytes(row.argumentsBytes)}`
		: lines !== undefined && !isFull
			? `Showing ${formatBytes(Math.min(payloadLinesBytes(lines), row.argumentsBytes))} of ${formatBytes(row.argumentsBytes)} · long strings shortened around the error path`
			: undefined
	return h.div(
		[h.Class("flex w-0 min-w-0 grow flex-col gap-2 max-lg:w-full")],
		[
			payloadHead(h, {
				label: "Arguments",
				attribute: "gen_ai.tool.call.arguments",
				bytes: row.argumentsBytes,
				action: button(
					h,
					{
						variant: "ghost",
						size: "xs",
						className: "font-mono text-2xs text-muted-foreground hover:text-foreground active:text-foreground sm:text-2xs",
						attributes: [h.OnClick(Message.ClickedCopyArguments({ text: row.arguments }))],
					},
					[copyLabel],
				),
			}),
			lines === undefined || isFull
				? h.pre(
						[
							h.Class(
								"max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-sidebar p-3 font-mono text-xs leading-[18px] text-foreground-soft",
							),
						],
						[args === undefined ? row.arguments : JSON.stringify(args, null, 2)],
					)
				: h.div(
						[
							h.Class(
								"flex flex-col overflow-x-auto rounded-md border border-border bg-sidebar py-3 font-mono text-xs leading-[18px]",
							),
						],
						lines.map((line) => payloadLineView(h, line)),
					),
			h.div(
				[
					h.Class(
						"flex items-center gap-2.5 font-mono text-2xs leading-3.5 text-foreground-subtle",
					),
				],
				[
					h.span([], note === undefined ? [] : [note]),
					h.span([h.Class("grow")], []),
					...(lines === undefined
						? []
						: [
								button(
									h,
									{
										variant: "outline",
										size: "xs",
										className: "text-2xs sm:text-2xs",
										attributes: [h.OnClick(Message.ToggledFullArguments())],
									},
									[isFull ? "Shorten" : "Show full payload"],
								),
							]),
				],
			),
		],
	)
}

const resultBlock = (h: H, row: ToolErrorOccurrenceRow): Html => {
	const parsed = parsePayload(row.result)
	const source = unwrapToolErrorText(row.result).source
	return h.div(
		[h.Class("flex w-[320px] shrink-0 flex-col gap-2 max-lg:w-full")],
		[
			payloadHead(h, { label: "Result", attribute: "gen_ai.tool.call.result", bytes: row.resultBytes }),
			row.result === ""
				? notRecorded(h, "result")
				: h.pre(
						[
							h.Class(
								"max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-severity-error-a3 bg-sidebar p-3 font-mono text-xs leading-[18px] text-foreground-soft",
							),
						],
						[parsed === undefined ? row.result : JSON.stringify(parsed, null, 2)],
					),
			...(source === undefined
				? []
				: [
						h.span(
							[h.Class("font-mono text-2xs leading-3.5 text-foreground-subtle")],
							["Error message read from ", source],
						),
					]),
		],
	)
}

/** The open sample: the "What's wrong" hint, an empty call's explanation, then both payloads. */
export const sampleBody = (h: H, model: Model, row: ToolErrorOccurrenceRow): Html => {
	const message = unwrapToolErrorText(row.message).text
	const args = parsePayload(row.arguments)
	const hint = whatsWrong(message, args)
	return h.div(
		[h.Class("flex flex-col gap-3.5 pr-6 pb-5 pl-[50px]")],
		[
			...(hint === undefined
				? []
				: [
						h.div(
							[
								h.Class(
									"flex items-baseline gap-3 rounded-md border border-severity-error-a3 bg-severity-error/[0.07] px-3 py-2 font-mono",
								),
							],
							[
								eyebrow(
									h,
									{ variant: "label", className: "shrink-0 leading-4 text-severity-error" },
									["What's wrong"],
								),
								h.span(
									[h.Class("text-xs leading-4 text-foreground-soft")],
									[
										h.span([h.Class("font-medium text-foreground")], [hint.subject]),
										" ",
										hint.text,
									],
								),
							],
						),
					]),
			...(row.arguments === "" && row.result === ""
				? [
						h.div(
							[
								h.Class(
									"flex items-start gap-3 rounded-md border border-border bg-sidebar p-3 font-mono",
								),
							],
							[
								statusDot(h, { tone: "custom", className: "mt-[5px] bg-muted-foreground" }),
								h.span(
									[h.Class("flex flex-col gap-1")],
									[
										h.span(
											[h.Class("text-xs leading-4 text-foreground")],
											["The tool reported no error detail"],
										),
										h.span(
											[h.Class("text-xs leading-[17px] text-muted-foreground")],
											[
												"This call recorded no arguments and no result, so the cause of the failure isn't in the telemetry. The message above is all the span carries.",
											],
										),
									],
								),
							],
						),
					]
				: []),
			h.div(
				[h.Class("flex items-start gap-4 max-lg:flex-col")],
				[argumentsBlock(h, model, row, message, args), resultBlock(h, row)],
			),
		],
	)
}
