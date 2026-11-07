import type { AiSessionSpan } from "@maple/domain/http"
import { callMetaLine, type SpanMessage, type SpanMessagePart } from "@maple/agent-sessions"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { tryParseJson } from "@maple/views/lib/display-text"
import { emptyMessage } from "@maple/views/ui/empty"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { firstLine, previewOf } from "./clamped-text"
import { Message } from "./message"
import type { Model } from "./model"
import { disclosed, jsonPayload, messageBody, viewSwitch } from "./payload-view"
import { clampedBody, payloadCopyButton } from "./transcript-kit"
import { shownMarkdown } from "./transcript-rows"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// The span expansion's Messages tab. Its local state (open,
// raw) lives in the page's `openRows` under the popover's key prefix, reset when the span changes.

type H = HtmlBuilder<Message>

/** The overlay is a reading surface: twice the transcript's clamp before it asks to be expanded. */
export const PANEL_CLAMP = 24

/** Every popover disclosure key starts here, so a new span starts from the defaults. */
export const POPOVER_KEY = "popover"

const ROLE_TEXT = new Map([
	["system", "text-muted-foreground"],
	["user", "text-primary"],
	["assistant", "text-chart-2"],
	["tool", "text-chart-4"],
])

const roleColor = (role: string): string => ROLE_TEXT.get(Str.toLowerCase(role)) ?? "text-muted-foreground"

/** A message's parts as one preview body; reasoning is labelled rather than dropped. */
const collapsedText = (parts: ReadonlyArray<SpanMessagePart>): string =>
	Str.trim(
		Arr.join(
			Arr.filter(
				Arr.map(parts, (part) => {
					if (part.kind === "text") return part.text
					if (part.kind === "reasoning")
						return part.text === undefined
							? "[thinking, no text captured]"
							: `THINKING\n${part.text}`
					return ""
				}),
				(text) => text !== "",
			),
			"\n",
		),
	)

/** A clamped panel body, keyed for its expansion and measured overflow. */
const panelBody = (
	h: H,
	model: Model,
	options: Readonly<{ text: string; key: string; isRaw: boolean; proseClassName?: string }>,
): Html => {
	const body = messageBody(options.text)
	return clampedBody(h, model, {
		text: options.isRaw ? options.text : body.formatted,
		textKey: `${options.key}:text`,
		rendering: options.isRaw ? "text" : body.rendered,
		isMono: !options.isRaw && body.rendered === "json",
		clampLines: PANEL_CLAMP,
		proseClassName: options.proseClassName ?? "text-sm",
	})
}

/** `PayloadCard`: a tool call or result inside a message, its body behind a json/raw switch. */
export const payloadCard = (
	h: H,
	model: Model,
	options: Readonly<{ label: string; name?: string; meta?: string; body?: string; key: string }>,
): Html =>
	h.div(
		[h.Class("min-w-0 overflow-hidden rounded-md border border-border-subtle")],
		[
			hstack(h, { gap: "2", align: "center", className: "bg-surface-sunken px-2.5 py-1.5" }, [
				h.span([h.AriaHidden(true), h.Class("size-1.5 shrink-0 rounded-xs bg-chart-4")], []),
				h.span([h.Class("shrink-0 font-medium font-mono text-chart-4 text-xs")], [options.label]),
				...(options.name === undefined
					? []
					: [
							typography(
								h,
								{
									size: "xs",
									tone: "foreground",
									mono: true,
									truncate: true,
									className: "min-w-0",
								},
								[options.name],
							),
						]),
				...(options.meta === undefined
					? []
					: [
							h.span(
								[
									h.Class(
										"ml-auto min-w-0 truncate font-mono text-2xs text-foreground-subtle",
									),
								],
								[options.meta],
							),
						]),
			]),
			...(options.body === undefined
				? []
				: [payloadBody(h, model, options.body, options.label, options.key)]),
		],
	)

const payloadBody = (h: H, model: Model, text: string, copyLabel: string, key: string): Html => {
	const { formatted, isJson } = jsonPayload(text)
	const isRaw = disclosed(model.openRows, `${key}:raw`, false)
	return hstack(
		h,
		{
			gap: "1.5",
			align: "start",
			className: "border-border-subtle border-t bg-background/50 px-2.5 py-2",
		},
		[
			h.div(
				[h.Class("min-w-0 grow")],
				[
					clampedBody(h, model, {
						text: isRaw ? text : formatted,
						textKey: `${key}:text`,
						rendering: !isRaw && isJson ? "json" : "text",
						clampLines: PANEL_CLAMP,
						isMono: true,
					}),
				],
			),
			...(isJson
				? [viewSwitch(h, { rendered: "json", isRaw, rawKey: `${key}:raw`, className: "self-start" })]
				: []),
			payloadCopyButton(h, model, {
				key: `${key}:copy`,
				value: isRaw ? text : formatted,
				label: copyLabel,
				className: "-my-1 shrink-0",
				hasTooltip: false,
			}),
		],
	)
}

/** Reasoning is the model thinking, set apart from the reply it precedes. */
const reasoningPart = (
	h: H,
	model: Model,
	part: Extract<SpanMessagePart, { kind: "reasoning" }>,
	key: string,
) =>
	h.div(
		[h.Class("min-w-0 border-chart-5/50 border-l-2 pl-2.5")],
		[
			eyebrow(h, { variant: "mono", className: "text-chart-5" }, ["Reasoning"]),
			part.redacted || part.text === undefined
				? typography(h, { size: "xs", tone: "muted", as: "p", className: "italic" }, [
						part.redacted
							? "Redacted by the provider. The reasoning was returned sealed."
							: "No reasoning text was captured.",
					])
				: clampedBody(h, model, { text: part.text, textKey: `${key}:text`, clampLines: PANEL_CLAMP }),
		],
	)

const messagePart = (h: H, model: Model, part: SpanMessagePart, isRaw: boolean, key: string): Html => {
	switch (part.kind) {
		case "text":
			return panelBody(h, model, { text: part.text, key, isRaw })
		case "reasoning":
			return reasoningPart(h, model, part, key)
		case "tool_call":
			return payloadCard(h, model, {
				label: "tool_call",
				name: part.name,
				meta: part.id,
				body: part.argumentsText,
				key,
			})
		default:
			return payloadCard(h, model, { label: "tool_result", meta: part.id, body: part.resultText, key })
	}
}

const messageBlock = (h: H, model: Model, message: SpanMessage, span: AiSessionSpan, key: string): Html => {
	const isRaw = disclosed(model.openRows, `${key}:raw`, false)
	const hasText = Arr.some(message.parts, (part) => part.kind === "text")
	const rendered = Arr.some(
		message.parts,
		(part) => part.kind === "text" && Option.isNone(tryParseJson(part.text)),
	)
		? "md"
		: "json"
	return vstack(h, { gap: "1.5", shrink: true }, [
		hstack(h, { gap: "2.5" }, [
			eyebrow(h, { variant: "mono", className: cn("shrink-0", roleColor(message.role)) }, [
				message.role,
			]),
			...(message.origin === "output"
				? [
						typography(
							h,
							{ size: "2xs", tone: "subtle", mono: true, truncate: true, className: "min-w-0" },
							[callMetaLine(span)],
						),
					]
				: []),
			h.span([h.AriaHidden(true), h.Class("h-px min-w-4 flex-1 bg-border-subtle")], []),
			...(hasText ? [viewSwitch(h, { rendered, isRaw, rawKey: `${key}:raw` })] : []),
		]),
		vstack(
			h,
			{ gap: "2", shrink: true },
			Arr.map(message.parts, (part, index) => messagePart(h, model, part, isRaw, `${key}:${index}`)),
		),
	])
}

/** The markdown bodies the Messages tab lays out, for the parse `update` asks for. */
export const popoverMarkdown = (
	model: Model,
	messages: ReadonlyArray<SpanMessage>,
	keyPrefix: string,
): ReadonlyArray<string> =>
	Arr.flatMap(messages, (message, index) => {
		const key = `${keyPrefix}:msg${index}`
		if (Str.toLowerCase(message.role) === "system")
			return disclosed(model.openRows, key, false)
				? shownMarkdown(model, key, collapsedText(message.parts))
				: []
		if (disclosed(model.openRows, `${key}:raw`, false)) return []
		return Arr.flatMap(message.parts, (part, partIndex) => {
			if (part.kind !== "text" || messageBody(part.text).rendered !== "md") return []
			const partKey = `${key}:${partIndex}`
			return [disclosed(model.openRows, `${partKey}:text`, false) ? part.text : previewOf(part.text)]
		})
	})

/** The Messages tab: every captured message, system ones folded to a line. */
export const messagesSection = (
	h: H,
	model: Model,
	messages: ReadonlyArray<SpanMessage>,
	span: AiSessionSpan,
	keyPrefix: string,
): Html =>
	messages.length === 0
		? emptyMessage(h, {}, [
				"No messages were captured on this span. Message capture is opt-in and off by default.",
			])
		: vstack(
				h,
				{ gap: "4", className: "pb-1" },
				Arr.map(messages, (message, index) =>
					Str.toLowerCase(message.role) === "system"
						? systemMessageRow(h, model, message, `${keyPrefix}:msg${index}`)
						: messageBlock(h, model, message, span, `${keyPrefix}:msg${index}`),
				),
			)

/** System instructions collapse to one line: they repeat on every call. */
const systemMessageRow = (h: H, model: Model, message: SpanMessage, key: string): Html => {
	const isOpen = disclosed(model.openRows, key, false)
	const isRaw = disclosed(model.openRows, `${key}:raw`, false)
	const text = collapsedText(message.parts)
	return panel(h, { tone: "muted", className: "border-border-subtle" }, [
		pressable(
			h,
			{
				onClick: Message.ToggledRow({ key }),
				className: "flex w-full items-center gap-2 px-2.5 py-2 text-left",
				attributes: [h.AriaExpanded(isOpen)],
			},
			[
				icon(h, isOpen ? "ChevronDownIcon" : "ChevronRightIcon", {
					size: 12,
					className: "shrink-0 text-muted-foreground",
				}),
				eyebrow(h, { variant: "mono", className: "shrink-0" }, [message.role]),
				...(isOpen
					? []
					: [
							typography(
								h,
								{ size: "xs", tone: "muted", truncate: true, className: "min-w-0" },
								[firstLine(text)],
							),
						]),
			],
		),
		...(isOpen
			? [
					hstack(h, { gap: "1.5", align: "start", className: "px-2.5 pb-2.5 pl-8" }, [
						h.div([h.Class("min-w-0 grow")], [panelBody(h, model, { text, key, isRaw })]),
						viewSwitch(h, {
							rendered: messageBody(text).rendered,
							isRaw,
							rawKey: `${key}:raw`,
							className: "self-start",
						}),
						payloadCopyButton(h, model, {
							key: `${key}:copy`,
							value: text,
							label: "system message",
							className: "-my-1 shrink-0",
							hasTooltip: false,
						}),
					]),
				]
			: []),
	])
}
