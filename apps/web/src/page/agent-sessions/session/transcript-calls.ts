import type { AiSessionSpan } from "@maple/domain/http"
import { callMetaLine, callMetaParts, spanModel, type TranscriptRow } from "@maple/agent-sessions"
import { formatDuration } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "../../../ui/icon"
import { truncatedText } from "../../../ui/truncated-text"
import { Message } from "./message"
import type { Model } from "./model"
import { disclosed, jsonPayload, viewSwitch } from "./payload-view"
import { clampedBody, messageBodyView, payloadCopyButton } from "./transcript-kit"
import { rowViewSwitch } from "./transcript-messages"
import { avatar, CLOCK, clockOf, inlineNote, META, ON_HOVER, row, SPEAKER } from "./transcript-shell"
import { failedBadge } from "./view-kit"

// The transcript's model calls: `AssistantBlock`, `PromptBlock`, `StructureRow`.

type H = HtmlBuilder<Message>

const mono = (h: H, text: string): Html => h.span([h.Class("font-mono")], [text])

const assistantError = (
	h: H,
	model: Model,
	assistant: Extract<TranscriptRow, { kind: "assistant" }>,
): Html => {
	const message = assistant.span.statusMessage
	const error = jsonPayload(message)
	const rawKey = `${assistant.key}:error-raw`
	const isRaw = disclosed(model.openRows, rawKey, false)
	return h.div(
		[h.Class("flex flex-col gap-1.5 pt-2.5")],
		[
			...(message === ""
				? []
				: [
						h.div(
							[h.Class("flex items-start gap-1.5")],
							[
								h.div(
									[h.Class("min-w-0 grow")],
									[
										clampedBody(h, model, {
											text: isRaw ? message : error.formatted,
											textKey: `${assistant.key}:error-text`,
											rendering: !isRaw && error.isJson ? "json" : "text",
											isMono: true,
											clampLines: 14,
											toneClass: "text-ui text-severity-error/90",
										}),
									],
								),
								...(error.isJson
									? [
											viewSwitch(h, {
												rendered: "json",
												isRaw,
												rawKey,
												className: "self-start",
											}),
										]
									: []),
								payloadCopyButton(h, model, {
									key: `${assistant.key}:error`,
									value: isRaw ? message : error.formatted,
									label: "error message",
									className: "-my-1 shrink-0",
								}),
							],
						),
					]),
			h.p([h.Class("text-muted-foreground text-xs")], ["No reply was produced by this call."]),
		],
	)
}

export type CallState = Readonly<{ isContinued: boolean; isSelected: boolean; timeZone: string }>

const assistantHeader = (
	h: H,
	assistant: Extract<TranscriptRow, { kind: "assistant" }>,
	state: CallState,
): Html => {
	const model = spanModel(assistant.span)
	const timing = callMetaParts(assistant.span, { usage: false }).slice(model === undefined ? 0 : 1)
	const { isContinued, isSelected } = state
	return h.button(
		[
			h.AriaPressed(String(isSelected)),
			h.Class("flex min-w-0 grow cursor-pointer items-center gap-2 text-left"),
			h.Type("button"),
			h.OnClick(Message.ClickedSpan({ spanId: isSelected ? undefined : assistant.span.spanId })),
		],
		[
			...(!isContinued || assistant.failed ? [h.span([h.Class(SPEAKER)], ["Assistant"])] : []),
			...(assistant.failed ? [failedBadge(h)] : []),
			h.span([h.Class(CLOCK)], [clockOf(assistant.startMs, state.timeZone)]),
			...(assistant.span.genAi.errorType === undefined
				? []
				: [
						h.span(
							[h.Class("shrink-0 font-mono text-2xs text-severity-error")],
							[assistant.span.genAi.errorType],
						),
					]),
			...(!isContinued && model !== undefined
				? [h.span([h.Class(cn(META, "shrink-0"))], [model])]
				: []),
			h.span([h.Class(cn(META, !isSelected && ON_HOVER))], [timing.join(" · ")]),
		],
	)
}

export const assistantBlock = (
	h: H,
	model: Model,
	assistant: Extract<TranscriptRow, { kind: "assistant" }>,
	state: CallState,
): Html => {
	const { text } = assistant
	const hasFace = !state.isContinued || assistant.failed
	return row(
		h,
		{
			depth: assistant.depth,
			avatar: hasFace
				? avatar(
						h,
						assistant.failed ? "CircleWarningIcon" : "PixelSparkleIcon",
						assistant.failed
							? "bg-severity-error/15 text-severity-error"
							: "bg-chart-2/15 text-chart-2",
					)
				: undefined,
			className: cn(
				"rounded-lg py-1.5",
				state.isContinued ? "mt-1" : "mt-3",
				state.isSelected && "bg-card ring-1 ring-border",
			),
		},
		[
			h.div(
				[h.Class("flex h-6 items-center gap-2")],
				[
					assistantHeader(h, assistant, state),
					...(text === undefined ? [] : [rowViewSwitch(h, model, assistant.key, text)]),
				],
			),
			...(text === undefined
				? []
				: [h.div([h.Class("pt-1")], [messageBodyView(h, model, { text, rowKey: assistant.key })])]),
			...(assistant.failed ? [assistantError(h, model, assistant)] : []),
			...(!assistant.failed && !assistant.toolCallsOnly && text === undefined
				? [
						inlineNote(
							h,
							[
								"The reply isn't captured. This emitter recorded the request but not",
								" ",
								mono(h, "gen_ai.output.messages"),
								", so the call's text is gone — it did not fail.",
							],
							"mt-2.5",
						),
					]
				: []),
		],
	)
}

export const promptBlock = (
	h: H,
	model: Model,
	prompt: Extract<TranscriptRow, { kind: "prompt" }>,
	timeZone: string,
): Html =>
	row(
		h,
		{
			depth: prompt.depth,
			avatar: avatar(h, "PixelSparkleIcon", "bg-chart-2/15 text-chart-2"),
			className: "pt-4",
		},
		[
			h.div(
				[h.Class("flex flex-col gap-1.5")],
				[
					h.div(
						[h.Class("flex h-6 items-center gap-2")],
						[
							h.span([h.Class(SPEAKER)], ["Prompt"]),
							h.span([h.Class(CLOCK)], [clockOf(prompt.startMs, timeZone)]),
							h.span(
								[h.Class(cn(META, ON_HOVER))],
								[callMetaLine(prompt.span, { usage: false }), " · ", prompt.span.serviceName],
							),
							h.span([h.Class("grow")], []),
							rowViewSwitch(h, model, prompt.key, prompt.text),
						],
					),
					messageBodyView(h, model, { text: prompt.text, rowKey: prompt.key }),
					inlineNote(h, [
						"The reply isn't captured. This emitter records",
						" ",
						mono(h, "gen_ai.input.messages"),
						" but not",
						" ",
						mono(h, "gen_ai.output.messages"),
						" — the call finished normally, but the text is gone.",
					]),
				],
			),
		],
	)

type StructureCategory = "tool" | "agent" | "inference"

const STRUCTURE_ICON = {
	tool: "GearIcon",
	agent: "FaceRobotIcon",
	inference: "PixelSparkleIcon",
} satisfies Record<StructureCategory, IconName>
const STRUCTURE_TONE = {
	tool: "text-chart-4",
	agent: "text-chart-1",
	inference: "text-chart-2",
} satisfies Record<StructureCategory, string>

const structureMeta = (
	span: AiSessionSpan,
	category: StructureCategory,
): Readonly<{ shown: string; onHover: string }> => {
	if (category === "tool") return { shown: `${span.serviceName} · payloads not captured`, onHover: "" }
	if (category === "agent") return { shown: `trace ${shortId(span.traceId, "trace")}`, onHover: "" }
	const parts = callMetaParts(span, { usage: false })
	return { shown: "", onHover: (spanModel(span) === undefined ? parts : parts.slice(1)).join(" · ") }
}

/** A model or tool call reduced to what it was: the emitter captured no content. */
export const structureRow = (
	h: H,
	structure: Extract<TranscriptRow, { kind: "structure" }>,
	state: CallState,
): Html => {
	const category: StructureCategory = structure.label.startsWith("tool ")
		? "tool"
		: structure.label.startsWith("agent ")
			? "agent"
			: "inference"
	const meta = structureMeta(structure.span, category)
	const { isSelected } = state
	return row(h, { depth: structure.depth, className: "pt-0.5" }, [
		h.div(
			[h.Class("flex items-center gap-2.5")],
			[
				h.button(
					[
						h.AriaPressed(String(isSelected)),
						h.Class(
							cn(
								"-mx-1.5 flex min-w-0 grow cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-muted/40",
								rowSelectedClass(isSelected),
							),
						),
						h.Type("button"),
						h.OnClick(
							Message.ClickedSpan({ spanId: isSelected ? undefined : structure.span.spanId }),
						),
					],
					[
						icon(h, STRUCTURE_ICON[category], {
							size: 13,
							className: cn(
								"shrink-0",
								structure.failed ? "text-severity-error" : STRUCTURE_TONE[category],
							),
						}),
						truncatedText(h, {
							text: structure.label,
							mono: true,
							className: "font-medium text-foreground text-xs",
						}),
						h.span([h.Class(cn(META, "shrink-0"))], [meta.shown]),
						h.span([h.Class(cn(META, !isSelected && ON_HOVER))], [meta.onHover]),
						h.span([h.Class("grow")], []),
						h.span(
							[h.Class(cn(META, "shrink-0"))],
							[
								h.span(
									[h.Class(ON_HOVER)],
									[clockOf(structure.startMs, state.timeZone), " · "],
								),
								formatDuration(structure.span.durationMs),
							],
						),
					],
				),
			],
		),
	])
}
