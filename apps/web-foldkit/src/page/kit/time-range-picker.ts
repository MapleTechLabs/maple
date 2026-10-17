import { cn } from "@maple/ui/lib/utils"
import { Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { button } from "../../ui/button"
import { eyebrow } from "../../ui/eyebrow"
import * as Popover from "../../ui/popover"
import { presetLabel, timeRangeTriggerContent } from "./time-controls"

// `TimeRangePicker` (apps/web/src/components/time-range-picker/time-range-picker.tsx): the header
// popover with the preset rail and quick select. Picking a range is an OutMessage; the page writes
// it to its URL search (`applyTimeRangeSearch`).
// TODO(picker): shorthand input, recently used, timezone select, custom range tab, the "D" hotkey
// and `maxRangeSeconds` (only presets past a year can exceed it) are not ported yet.

export const Model = Popover.Model
export type Model = Popover.Model

export const init = (id: string): Model => Popover.init(id, { align: "end" })

export const Message = defineMessageUnion({
	GotPopoverMessage: { message: Popover.Message },
	ClickedPreset: { value: Schema.String },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	SelectedPreset: { presetValue: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const liftPopover = (result: Update.Return<Model, Popover.Message>): Return => ({
	model: result.model,
	commands: Command.mapMessages(result.commands, (message) => Message.GotPopoverMessage({ message })),
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPopoverMessage: ({ message: inner }) => liftPopover(Popover.update(model, inner)),
		ClickedPreset: ({ value }) => ({
			...liftPopover(Popover.close(model)),
			outMessage: OutMessage.SelectedPreset({ presetValue: value }),
		}),
	})

/** The list presets (`LONG_RANGE_PRESET_OPTIONS` for long-range pages, else `PRESET_OPTIONS`). */
export const PRESET_VALUES = ["5m", "15m", "30m", "1h", "6h", "12h", "1d", "3d", "1w", "2w", "1mo"]
export const LONG_RANGE_PRESET_VALUES = [...PRESET_VALUES, "3mo", "6mo", "12mo"]
const LONG_LABELS = new Map([
	["3mo", "Last 3 months"],
	["6mo", "Last 6 months"],
])
const QUICK_SELECT = ["3h", "4d", "6w", "12h", "10d", "2w", "2mo", "today"]

const presetList = (
	h: HtmlBuilder<Message>,
	presets: ReadonlyArray<string>,
	selected: string | undefined,
): Html =>
	h.div(
		[h.Class("flex h-full flex-col py-2")],
		[
			eyebrow(h, { as: "div", className: "px-3 pb-2" }, ["Presets"]),
			h.div(
				[h.Class("flex flex-col")],
				presets.map((value) => {
					const isActive = selected === value
					return h.button(
						[
							h.Key(value),
							h.Type("button"),
							h.OnClick(Message.ClickedPreset({ value })),
							h.Class(
								cn(
									"relative flex h-7 items-center pl-3 pr-2 text-left text-xs transition-colors",
									"before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-r before:bg-transparent before:transition-colors",
									"hover:bg-muted/50",
									isActive && "text-foreground before:bg-primary",
									!isActive && "text-foreground/80",
								),
							),
						],
						[
							h.span(
								[h.Class(cn("tabular-nums", isActive && "font-medium"))],
								[LONG_LABELS.get(value) ?? presetLabel(value)],
							),
						],
					)
				}),
			),
			h.div([h.Class("mx-3 mt-1 h-px bg-border/60")], []),
			h.button(
				[
					h.Type("button"),
					h.Class(
						"mt-1 flex h-7 items-center pl-3 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
					),
				],
				["Custom range…"],
			),
		],
	)

const quickSelect = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("space-y-2")],
		[
			eyebrow(h, { as: "div" }, ["Quick select"]),
			h.div(
				[h.Class("grid grid-cols-4 gap-1.5")],
				QUICK_SELECT.map((value) =>
					h.button(
						[
							h.Key(value),
							h.Type("button"),
							h.OnClick(Message.ClickedPreset({ value })),
							h.Class(
								"flex h-7 items-center justify-center rounded-md border border-border/60 bg-background/30 font-mono text-2xs tracking-wide text-foreground/90 transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							),
						],
						[value],
					),
				),
			),
		],
	)

export type ViewInputs = Readonly<{
	label: string
	selectedPreset: string | undefined
	presets: ReadonlyArray<string>
}>

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
	h.submodel({
		slotId: "time-range-popover",
		model,
		view: Popover.view,
		toParentMessage: (message) => Message.GotPopoverMessage({ message }),
		viewInputs: {
			className: "w-[520px] max-w-[calc(100vw-1.5rem)] p-0",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								className: "gap-2",
								slot: "popover-trigger",
								attributes: [...trigger, h.Title("Time range (D)")],
							},
							timeRangeTriggerContent(h, inputs.label),
						),
					),
				),
			toContent: () => [
				h.div(
					[h.Class("flex flex-col")],
					[
						h.div(
							[h.Class("flex flex-col sm:flex-row sm:items-stretch")],
							[
								h.div(
									[
										h.Class(
											"w-full shrink-0 border-b border-border/70 sm:w-[168px] sm:border-r sm:border-b-0",
										),
									],
									[presetList(h, inputs.presets, inputs.selectedPreset)],
								),
								h.div([h.Class("min-w-0 flex-1 space-y-5 p-4")], [quickSelect(h)]),
							],
						),
					],
				),
			],
		},
	}),
)
