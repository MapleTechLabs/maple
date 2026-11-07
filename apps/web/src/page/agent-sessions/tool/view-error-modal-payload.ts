import { Schema, Array as Arr } from "effect"
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
import { button } from "@maple/views/ui/button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { statusDot } from "@maple/views/ui/status-dot"
import { Message, type Model, type ToolErrorOccurrenceRow } from "./error-modal-model"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))

// `SampleBody` of `ToolErrorModal`: what the call was handed and what it gave back, and where the
// arguments confirm a schema failure, what is wrong with them.

type H = HtmlBuilder<Message>

const payloadHead = (
	h: H,
	options: Readonly<{ label: string; attribute: string; bytes: number; action?: Html }>,
): Html =>
	hstack(h, { gap: "2", align: "center", className: "font-mono leading-3.5" }, [
		eyebrow(h, { variant: "mono" }, [options.label]),
		typography(h, { size: "2xs", tone: "faint", truncate: true }, [
			options.attribute,
			...(options.bytes > 0 ? [` · ${formatBytes(options.bytes)}`] : []),
		]),
		h.span([h.Class("grow")], []),
		...(options.action === undefined ? [] : [options.action]),
	])

const notRecorded = (h: H, what: "arguments" | "result"): Html =>
	vstack(h, { gap: "1", className: "rounded-md border border-dashed border-input p-3.5 font-mono" }, [
		typography(h, { size: "xs", tone: "muted" }, ["Not recorded"]),
		typography(h, { size: "2xs", tone: "subtle", className: "leading-3.75" }, [
			"The span has no ",
			what,
			" attribute.",
		]),
	])

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
				? hstack(
						h,
						{
							gap: "2",
							align: "center",
							inline: true,
							as: "span",
							className:
								"my-0.5 rounded-xs border border-dashed border-severity-error-a4 px-1.5 text-2xs leading-4 text-severity-error",
						},
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
						hstack(h, { gap: "2.5", align: "center", className: "pb-1 text-2xs leading-3.5" }, [
							typography(h, { tone: "error" }, ["↑ ", line.note.text]),
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
						]),
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
		return vstack(h, { gap: "2", shrink: true, className: "w-0 grow max-lg:w-full" }, [
			payloadHead(h, { label: "Arguments", attribute: "gen_ai.tool.call.arguments", bytes: 0 }),
			notRecorded(h, "arguments"),
		])
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
	return vstack(h, { gap: "2", shrink: true, className: "w-0 grow max-lg:w-full" }, [
		payloadHead(h, {
			label: "Arguments",
			attribute: "gen_ai.tool.call.arguments",
			bytes: row.argumentsBytes,
			action: button(
				h,
				{
					variant: "ghost",
					size: "xs",
					className:
						"font-mono text-2xs text-muted-foreground hover:text-foreground active:text-foreground sm:text-2xs",
					attributes: [h.OnClick(Message.ClickedCopyArguments({ text: row.arguments }))],
				},
				[copyLabel],
			),
		}),
		lines === undefined || isFull
			? h.pre(
					[
						h.Class(
							"max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-sidebar p-3 font-mono text-xs leading-4.5 text-foreground-soft",
						),
					],
					[args === undefined ? row.arguments : encodePrettyJson(args)],
				)
			: vstack(
					h,
					{
						className:
							"overflow-x-auto rounded-md border border-border bg-sidebar py-3 font-mono text-xs leading-4.5",
					},
					Arr.map(lines, (line) => payloadLineView(h, line)),
				),
		hstack(
			h,
			{
				gap: "2.5",
				align: "center",
				className: "font-mono text-2xs leading-3.5 text-foreground-subtle",
			},
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
	])
}

const resultBlock = (h: H, row: ToolErrorOccurrenceRow): Html => {
	const parsed = parsePayload(row.result)
	const source = unwrapToolErrorText(row.result).source
	return vstack(h, { gap: "2", className: "w-[320px] shrink-0 max-lg:w-full" }, [
		payloadHead(h, { label: "Result", attribute: "gen_ai.tool.call.result", bytes: row.resultBytes }),
		row.result === ""
			? notRecorded(h, "result")
			: h.pre(
					[
						h.Class(
							"max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-severity-error-a3 bg-sidebar p-3 font-mono text-xs leading-4.5 text-foreground-soft",
						),
					],
					[parsed === undefined ? row.result : encodePrettyJson(parsed)],
				),
		...(source === undefined
			? []
			: [
					typography(h, { size: "2xs", tone: "subtle", mono: true, className: "leading-3.5" }, [
						"Error message read from ",
						source,
					]),
				]),
	])
}

/** The open sample: the "What's wrong" hint, an empty call's explanation, then both payloads. */
export const sampleBody = (h: H, model: Model, row: ToolErrorOccurrenceRow): Html => {
	const message = unwrapToolErrorText(row.message).text
	const args = parsePayload(row.arguments)
	const hint = whatsWrong(message, args)
	return vstack(h, { className: "gap-3.5 pr-6 pb-5 pl-12.5" }, [
		...(hint === undefined
			? []
			: [
					hstack(
						h,
						{
							gap: "3",
							align: "baseline",
							className:
								"rounded-md border border-severity-error-a3 bg-severity-error/[0.07] px-3 py-2 font-mono",
						},
						[
							eyebrow(
								h,
								{ variant: "label", className: "shrink-0 leading-4 text-severity-error" },
								["What's wrong"],
							),
							typography(h, { size: "xs", tone: "soft", className: "leading-4" }, [
								typography(h, { tone: "foreground", weight: "medium" }, [hint.subject]),
								" ",
								hint.text,
							]),
						],
					),
				]),
		...(row.arguments === "" && row.result === ""
			? [
					hstack(
						h,
						{
							gap: "3",
							align: "start",
							className: "rounded-md border border-border bg-sidebar p-3 font-mono",
						},
						[
							statusDot(h, { tone: "custom", className: "mt-1.25 bg-muted-foreground" }),
							vstack(h, { gap: "1", as: "span" }, [
								typography(h, { size: "xs", tone: "foreground", className: "leading-4" }, [
									"The tool reported no error detail",
								]),
								typography(h, { size: "xs", tone: "muted", className: "leading-4.25" }, [
									"This call recorded no arguments and no result, so the cause of the failure isn't in the telemetry. The message above is all the span carries.",
								]),
							]),
						],
					),
				]
			: []),
		h.div(
			[h.Class("flex items-start gap-4 max-lg:flex-col")],
			[argumentsBlock(h, model, row, message, args), resultBlock(h, row)],
		),
	])
}
