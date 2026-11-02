import type { TranscriptRow } from "@maple/agent-sessions"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { pressable } from "../../../ui/pressable"
import { textLink } from "../../../ui/text-link"
import { Message } from "./message"
import type { Model } from "./model"
import { disclosed, messageBody, viewSwitch } from "./payload-view"
import { firstLine } from "./clamped-text"
import { clampedBody, messageBodyView, payloadCopyButton } from "./transcript-kit"
import { avatar, CLOCK, clockOf, LABEL, META, ON_HOVER, row, SPEAKER } from "./transcript-shell"

// The transcript's people and prompts: `UserBlock`, `SystemBlock`, `ThinkingBlock`.

type H = HtmlBuilder<Message>

/** The rendered/raw switch of a message row, keyed `${rowKey}:raw`. */
export const rowViewSwitch = (h: H, model: Model, rowKey: string, text: string, className?: string): Html => {
	const isRaw = disclosed(model.openRows, `${rowKey}:raw`, false)
	return viewSwitch(h, {
		rendered: messageBody(text).rendered,
		isRaw,
		rawKey: `${rowKey}:raw`,
		className: className ?? (isRaw ? undefined : ON_HOVER),
	})
}

const historyToggle = (h: H, model: Model, user: Extract<TranscriptRow, { kind: "user" }>): Html => {
	const historyKey = `${user.key}:history`
	const isShown = disclosed(model.openRows, historyKey, false)
	// TODO(tooltip): "N earlier messages re-sent with this one, shown once" is drawn as its trigger.
	return textLink(
		h,
		{
			tone: "muted",
			onClick: Message.ToggledRow({ key: historyKey }),
			className: cn("shrink-0 text-2xs", !isShown && ON_HOVER),
			attributes: [
				h.AriaExpanded(isShown),
				h.DataAttribute("base-ui-tooltip-trigger", ""),
				h.DataAttribute("slot", "tooltip-trigger"),
			],
		},
		[isShown ? "hide history" : `+${user.earlierCount} re-sent`],
	)
}

const history = (h: H, model: Model, user: Extract<TranscriptRow, { kind: "user" }>): Html =>
	h.div(
		[h.Class("flex flex-col gap-3 rounded-md border border-border-subtle bg-surface-faint p-3")],
		[
			h.p(
				[h.Class("text-2xs text-muted-foreground")],
				["The whole history this call re-sent, as captured."],
			),
			...user.history.map((message, index) =>
				h.div(
					[h.Key(String(index)), h.Class("flex flex-col gap-1")],
					[
						h.span([h.Class(cn(LABEL, "text-muted-foreground"))], [message.role]),
						clampedBody(h, model, {
							text: message.parts
								.map((part) => (part.kind === "text" ? part.text : `[${part.kind}]`))
								.join("\n"),
							textKey: `${user.key}:history-${index}`,
							clampLines: 6,
						}),
					],
				),
			),
		],
	)

export const userBlock = (
	h: H,
	model: Model,
	user: Extract<TranscriptRow, { kind: "user" }>,
	timeZone: string,
): Html =>
	row(h, { depth: user.depth, className: "pt-5" }, [
		h.div(
			[h.Class("flex flex-col gap-1.5")],
			[
				h.div(
					[h.Class("flex h-6 items-center justify-end gap-2")],
					[
						...(user.earlierCount > 0 ? [historyToggle(h, model, user)] : []),
						rowViewSwitch(h, model, user.key, user.text),
						h.span([h.Class(CLOCK)], [clockOf(user.startMs, timeZone)]),
						h.span([h.Class(SPEAKER)], ["User"]),
						avatar(h, "UserIcon", "bg-foreground text-background"),
					],
				),
				h.div(
					[
						h.Class(
							"mr-8 ml-auto w-fit max-w-[85%] rounded-lg rounded-tr-sm bg-surface-sunken px-3.5 py-2.5",
						),
					],
					[messageBodyView(h, model, { text: user.text, rowKey: user.key })],
				),
				...(disclosed(model.openRows, `${user.key}:history`, false) ? [history(h, model, user)] : []),
			],
		),
	])

const chevron = (h: H, isOpen: boolean, className: string): Html =>
	icon(h, isOpen ? "ChevronDownIcon" : "ChevronRightIcon", { size: 12, className })

const systemCoverage = (calls: number, turnCalls: number): string =>
	calls >= turnCalls
		? calls === 1
			? "sent on 1 call"
			: `sent on all ${calls} calls`
		: `sent on ${calls} of ${turnCalls} calls`

/** System instructions collapse to one line: emitters re-send them on every call. */
export const systemBlock = (h: H, model: Model, system: Extract<TranscriptRow, { kind: "system" }>): Html => {
	const isOpen = disclosed(model.openRows, system.key, false)
	return row(h, { depth: system.depth, className: "pt-3" }, [
		pressable(
			h,
			{
				onClick: Message.ToggledRow({ key: system.key }),
				className:
					"flex w-full items-center gap-2 py-0.5 text-left text-muted-foreground hover:text-foreground active:text-foreground",
				attributes: [h.AriaExpanded(isOpen)],
			},
			[
				chevron(h, isOpen, "shrink-0 text-muted-foreground"),
				h.span([h.Class("shrink-0 font-medium text-xs")], ["System prompt"]),
				...(isOpen
					? []
					: [
							h.span(
								[h.Class("min-w-0 grow truncate text-foreground-subtle text-xs")],
								[firstLine(system.text)],
							),
						]),
				h.span([h.Class("grow")], []),
				// Every prompt row says its call coverage, so two variants in a turn read side by side.
				h.span(
					[h.Class(cn(META, "shrink-0"))],
					[systemCoverage(system.callCount, system.turnCallCount)],
				),
			],
		),
		...(isOpen
			? [
					h.div(
						[h.Class("mt-1 flex items-start gap-1.5 rounded-lg bg-surface-sunken px-3.5 py-2.5")],
						[
							h.div(
								[h.Class("min-w-0 grow")],
								[
									messageBodyView(h, model, {
										text: system.text,
										rowKey: system.key,
										proseClassName: "text-sm",
									}),
								],
							),
							rowViewSwitch(h, model, system.key, system.text, "self-start"),
							payloadCopyButton(h, model, {
								key: system.key,
								value: system.text,
								label: "system prompt",
								className: "-my-1 shrink-0",
							}),
						],
					),
				]
			: []),
	])
}

/** Reasoning: collapsed by default, never set as assistant prose. */
export const thinkingBlock = (
	h: H,
	model: Model,
	thinking: Extract<TranscriptRow, { kind: "thinking" }>,
	timeZone: string,
): Html => {
	const isOpen = disclosed(model.openRows, thinking.key, false)
	const { text } = thinking
	return row(h, { depth: thinking.depth, className: "pt-2" }, [
		pressable(
			h,
			{
				onClick: Message.ToggledRow({ key: thinking.key }),
				isDisabled: text === undefined,
				// Nothing to expand reads as a plain line, not a dimmed control.
				className:
					"flex w-full items-center gap-2 py-0.5 text-left disabled:cursor-default disabled:opacity-100",
				attributes: [h.AriaExpanded(isOpen), h.Title(clockOf(thinking.startMs, timeZone))],
			},
			[
				text === undefined
					? h.span([h.AriaHidden(true), h.Class("w-[11px] shrink-0")], [])
					: chevron(h, isOpen, "shrink-0 text-chart-5"),
				h.span([h.Class("shrink-0 font-medium text-chart-5 text-xs italic")], ["Thinking"]),
				...(thinking.redacted || text === undefined
					? [
							h.span(
								[h.Class("shrink-0 text-muted-foreground text-xs")],
								[
									thinking.redacted
										? "redacted by the provider"
										: "no reasoning text captured",
								],
							),
						]
					: []),
			],
		),
		...(isOpen && text !== undefined
			? [
					h.div(
						[h.Class("mt-1 mb-1 rounded-lg bg-chart-5/6 px-3.5 py-2.5")],
						[clampedBody(h, model, { text, textKey: `${thinking.key}:text` })],
					),
				]
			: []),
	])
}
