import { IsoDateTimeString, type TimeRange } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { resolveRelativeRangeToWarehouse } from "@maple/query-engine"
import { parseWarehouseDateTime, relativeRangeSeconds } from "@maple/query-engine/datetime"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { kbdStyles } from "@maple/ui/styles/ui/kbd"
import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Clock, Effect, Option, Schema, type Stream } from "effect"
import { Command, Dom, Mount, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { button } from "../../ui/button"
import { eyebrow } from "../../ui/eyebrow"
import { icon } from "../../ui/icon"
import * as Popover from "../../ui/popover"
import { PageOutMessage } from "../contract"
import * as CustomRange from "./custom-range"
import * as CustomRangeView from "./custom-range-view"
import { presetLabel, timeRangeTriggerContent } from "./time-controls"

// `TimeRangePicker` (apps/web/src/components/time-range-picker/time-range-picker.tsx): the header
// popover with the preset rail and quick select. Picking a range is an OutMessage; the page writes
// it to its URL search (`applyTimeRangeSearch`).
// TODO(picker): recently used is not ported yet.

export const Tab = Schema.Literals(["relative", "custom"])
export type Tab = typeof Tab.Type

export const Model = Schema.Struct({
	popover: Popover.Model,
	/** `TimeRangeTab`; the custom tab holds its calendar state while it is shown. */
	tab: Tab,
	custom: Schema.NullOr(CustomRange.Model),
	/** `ShorthandInput`: the typed duration and whether Enter rejected it. */
	shorthand: Schema.String,
	isShorthandInvalid: Schema.Boolean,
	/** The footer's `formatUtcOffset(timeZone)`, read when the footer mounts (each open). */
	utcOffset: Schema.NullOr(Schema.Struct({ timeZone: Schema.String, label: Schema.String })),
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	popover: Popover.init(id, { align: "end" }),
	tab: "relative",
	custom: null,
	shorthand: "",
	isShorthandInvalid: false,
	utcOffset: null,
})

/** The page's `maxRangeSeconds`, carried by the Messages that pick a range. */
const MaxRange = Schema.optionalKey(Schema.Number)

export const Message = defineMessageUnion({
	GotPopoverMessage: { message: Popover.Message },
	ClickedPreset: { value: Schema.String, maxRangeSeconds: MaxRange },
	ChangedShorthand: { value: Schema.String },
	PressedShorthandEnter: { maxRangeSeconds: MaxRange },
	ResolvedUtcOffset: { timeZone: Schema.String, label: Schema.String },
	/** "Custom range…": the tab opens on the shown window once the clock gave today. */
	ClickedCustomRange: {
		startTime: Schema.NullOr(Schema.String),
		endTime: Schema.NullOr(Schema.String),
		timeZone: Schema.String,
	},
	ResolvedCustomToday: {
		startTime: Schema.NullOr(Schema.String),
		endTime: Schema.NullOr(Schema.String),
		timeZone: Schema.String,
		today: CustomRange.CalendarDate,
		lastDay: CustomRange.CalendarDate,
	},
	GotCustomRangeMessage: { message: CustomRange.Message, maxRangeSeconds: MaxRange },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	SelectedPreset: { presetValue: Schema.String },
	/** `handleCustomApply`: an absolute window, no preset. */
	SelectedCustomRange: { startTime: Schema.String, endTime: Schema.String },
	/** `rangeAllowed` refused it: the page shows the error toast. */
	RejectedRange: { maxRangeSeconds: Schema.Number },
})
export type OutMessage = typeof OutMessage.Type

/** The URL time fields a picked range writes (`applyTimeRangeSearch`). */
export type TimeSearchPatch = Readonly<{
	startTime: string | undefined
	endTime: string | undefined
	timePreset: string | undefined
}>

/** `applyTimeRangeSearch`: a preset clears the bounds; a custom range clears the preset. */
export const searchPatchOf = (
	out: Extract<OutMessage, { readonly _tag: "SelectedPreset" | "SelectedCustomRange" }>,
): TimeSearchPatch =>
	out._tag === "SelectedPreset"
		? { startTime: undefined, endTime: undefined, timePreset: out.presetValue }
		: { startTime: out.startTime, endTime: out.endTime, timePreset: undefined }

const decodeIso = Schema.decodeUnknownOption(IsoDateTimeString)

/** The dashboard toolbar's `setTimeRange`: a preset is relative, a custom range absolute; else none. */
export const dashboardTimeRangeOf = (out: OutMessage | undefined): TimeRange | undefined => {
	if (out === undefined || out._tag === "RejectedRange") return undefined
	if (out._tag === "SelectedPreset") return { type: "relative", value: out.presetValue }
	const bounds = Option.all({ startTime: decodeIso(out.startTime), endTime: decodeIso(out.endTime) })
	return Option.match(bounds, {
		onNone: () => undefined,
		onSome: ({ startTime, endTime }): TimeRange => ({ type: "absolute", startTime, endTime }),
	})
}

/** `rangeAllowed`'s toast: "This page supports a maximum range of N days". */
export const rejectedToast = (maxRangeSeconds: number): PageOutMessage =>
	PageOutMessage.RequestedToast({
		type: "error",
		title: `This page supports a maximum range of ${Math.round(maxRangeSeconds / 86400)} days`,
		description: "",
	})

/** A page step where the picker picked nothing; a refused range adds `rejectedToast`. */
export const unpicked = <R extends object>(
	step: R,
	out: OutMessage | undefined,
): R | (R & { readonly outMessage: PageOutMessage }) =>
	out?._tag === "RejectedRange" ? { ...step, outMessage: rejectedToast(out.maxRangeSeconds) } : step

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const liftPopover = (model: Model, result: Update.Return<Popover.Model, Popover.Message>): Return => ({
	model: { ...model, popover: result.model },
	commands: Command.mapMessages(result.commands, (message) => Message.GotPopoverMessage({ message })),
})

/** `relativeToAbsolute` resolves it: a duration (`2h`, `4d`, `2mo`) or `today`. */
const isValidShorthand = (value: string): boolean => resolveRelativeRangeToWarehouse(value, 0, "UTC") !== null

/** `isTimeRangeWithin`; a relative value is sized by `relativeRangeSeconds` (a month is 30 days). */
const isWithin = (seconds: number | null, maxRangeSeconds: number | undefined): boolean =>
	maxRangeSeconds === undefined || (seconds !== null && Number.isFinite(seconds) && seconds >= 0 && seconds <= maxRangeSeconds)

const rejected = (model: Model, maxRangeSeconds: number): Return => ({
	model,
	outMessage: OutMessage.RejectedRange({ maxRangeSeconds }),
})

/** A picked preset or typed shorthand: refused past the page's maximum, else applied and closed. */
const pickedPreset = (model: Model, value: string, maxRangeSeconds: number | undefined): Return =>
	maxRangeSeconds !== undefined && !isWithin(relativeRangeSeconds(value), maxRangeSeconds)
		? rejected(model, maxRangeSeconds)
		: {
				...liftPopover(model, Popover.close(model.popover)),
				outMessage: OutMessage.SelectedPreset({ presetValue: value }),
			}

export const ResolveCustomToday = Command.define("ResolveCustomRangeToday", {
	args: {
		startTime: Schema.NullOr(Schema.String),
		endTime: Schema.NullOr(Schema.String),
		timeZone: Schema.String,
	},
	messages: [Message.ResolvedCustomToday],
	execute: (seed) => Effect.map(CustomRange.readToday(seed.timeZone), (days) => Message.ResolvedCustomToday({ ...seed, ...days })),
})

const customStep = (model: Model, custom: CustomRange.Model, inner: CustomRange.Message, maxRangeSeconds: number | undefined): Return => {
	const next = CustomRange.update(custom, inner)
	const stepped = { ...model, custom: next.model }
	return Option.match(Option.fromNullishOr(next.outMessage), {
		onNone: () => ({ model: stepped }),
		onSome: CustomRange.OutMessage.match<Return>({
			CancelledRange: () => ({ model: { ...stepped, tab: "relative", custom: null } }),
			AppliedRange: ({ startTime, endTime }) =>
				isWithin((parseWarehouseDateTime(endTime) - parseWarehouseDateTime(startTime)) / 1000, maxRangeSeconds)
					? {
							...liftPopover({ ...stepped, tab: "relative", custom: null }, Popover.close(model.popover)),
							outMessage: OutMessage.SelectedCustomRange({ startTime, endTime }),
						}
					: rejected(stepped, maxRangeSeconds ?? 0),
		}),
	})
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPopoverMessage: ({ message: inner }) => liftPopover(model, Popover.update(model.popover, inner)),
		ClickedPreset: ({ value, maxRangeSeconds }) => pickedPreset(model, value, maxRangeSeconds),
		ChangedShorthand: ({ value }) => ({
			model: { ...model, shorthand: value, isShorthandInvalid: false },
		}),
		PressedShorthandEnter: ({ maxRangeSeconds }) =>
			isValidShorthand(model.shorthand)
				? pickedPreset(
						{ ...model, shorthand: "", isShorthandInvalid: false },
						model.shorthand.toLowerCase(),
						maxRangeSeconds,
					)
				: { model: { ...model, isShorthandInvalid: true } },
		ResolvedUtcOffset: ({ timeZone, label }) => ({ model: { ...model, utcOffset: { timeZone, label } } }),
		ClickedCustomRange: ({ _tag, ...seed }) => ({ model, commands: [ResolveCustomToday(seed)] }),
		ResolvedCustomToday: (seed) => ({ model: { ...model, tab: "custom", custom: CustomRange.init(seed) } }),
		GotCustomRangeMessage: ({ message: inner, maxRangeSeconds }) =>
			model.custom === null ? { model } : customStep(model, model.custom, inner, maxRangeSeconds),
	})

/** The list presets (`LONG_RANGE_PRESET_OPTIONS` for long-range pages, else `PRESET_OPTIONS`). */
export const PRESET_VALUES = ["5m", "15m", "30m", "1h", "6h", "12h", "1d", "3d", "1w", "2w", "1mo"]
export const LONG_RANGE_PRESET_VALUES = [...PRESET_VALUES, "3mo", "6mo", "12mo"]
const LONG_LABELS = new Map([
	["3mo", "Last 3 months"],
	["6mo", "Last 6 months"],
])
const QUICK_SELECT = ["3h", "4d", "6w", "12h", "10d", "2w", "2mo", "today"]

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60

/** The page's maximum; every legacy page on the long-range presets also caps at a year. */
const maxRangeOf = (inputs: ViewInputs): number | undefined =>
	inputs.maxRangeSeconds ?? (inputs.presets === LONG_RANGE_PRESET_VALUES ? ONE_YEAR_SECONDS : undefined)

/** The page's maximum on a Message, when it has one. */
const withMax = (inputs: ViewInputs) => {
	const maxRangeSeconds = maxRangeOf(inputs)
	return maxRangeSeconds === undefined ? {} : { maxRangeSeconds }
}

/** `CustomRangePicker`'s `startTime`/`endTime`: the shown window, when the page passes it. */
const customSeed = (inputs: ViewInputs) => ({
	startTime: inputs.startTime ?? null,
	endTime: inputs.endTime ?? null,
	timeZone: inputs.timeZone ?? "UTC",
})

const presetList = (h: HtmlBuilder<Message>, inputs: ViewInputs): Html =>
	h.div(
		[h.Class("flex h-full flex-col py-2")],
		[
			eyebrow(h, { as: "div", className: "px-3 pb-2" }, ["Presets"]),
			h.div(
				[h.Class("flex flex-col")],
				inputs.presets.map((value) => {
					const isActive = inputs.selectedPreset === value
					return h.button(
						[
							h.Key(value),
							h.Type("button"),
							h.OnClick(Message.ClickedPreset({ value, ...withMax(inputs) })),
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
					h.OnClick(Message.ClickedCustomRange(customSeed(inputs))),
					h.Class(
						"mt-1 flex h-7 items-center pl-3 pr-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
					),
				],
				["Custom range…"],
			),
		],
	)

const quickSelect = (h: HtmlBuilder<Message>, inputs: ViewInputs): Html =>
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
							h.OnClick(Message.ClickedPreset({ value, ...withMax(inputs) })),
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
	/** `useTimezonePreference().effectiveTimezone` for the footer (default UTC). */
	timeZone?: string
	/** `hotkey`: only the page-level picker answers "D" and titles itself with it (default false). */
	hasHotkey?: boolean
	/** The window the custom tab opens on (`startTime`/`endTime` props). */
	startTime?: string
	endTime?: string
	/** `maxRangeSeconds`: a wider pick is refused with a toast. */
	maxRangeSeconds?: number
}>

/** `ShorthandInput`: type a duration, Enter applies it. */
const shorthandInput = (h: HtmlBuilder<Message>, model: Model, inputs: ViewInputs): Html =>
	h.div(
		[h.Class("space-y-1.5")],
		[
			h.div(
				[
					h.Class(
						cn(
							"group flex h-9 items-center gap-2 rounded-md border bg-background/40 pl-3 pr-1.5 transition-colors",
							"focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20",
							model.isShorthandInvalid
								? "border-destructive/70"
								: "border-border/70 hover:border-border",
						),
					),
				],
				[
					h.span([h.Class("font-mono text-2xs text-muted-foreground/70 select-none")], ["›"]),
					h.input([
						h.Value(model.shorthand),
						h.OnInput((value) => Message.ChangedShorthand({ value })),
						h.OnKeyDownPreventDefault((key) =>
							key === "Enter" ? Option.some(Message.PressedShorthandEnter(withMax(inputs))) : Option.none(),
						),
						h.Placeholder("1m · 2h · 4d · 6w · today"),
						h.Class(
							"flex-1 bg-transparent font-mono text-sm tracking-tight text-foreground placeholder:text-muted-foreground/50 focus:outline-none",
						),
						h.Spellcheck(false),
						h.Autocomplete("off"),
					]),
					h.kbd(
						[
							h.Class(cn(kbdStyles, model.shorthand.length === 0 && "hidden")),
							h.DataAttribute("slot", "kbd"),
						],
						["↵"],
					),
				],
			),
			h.p(
				[
					h.Class(
						cn(
							"px-1 font-mono text-3xs transition-colors",
							model.isShorthandInvalid ? TONE_TEXT.crit : "text-muted-foreground/60",
						),
					),
				],
				[
					model.isShorthandInvalid
						? "Try 5m, 2h, 4d, 1w, 2mo, or today"
						: "Type a duration and press enter",
				],
			),
		],
	)

/** An unknown zone throws in the constructor; legacy then shows `UTC`. */
const offsetFormatter = Option.liftThrowable(
	(timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }),
)

/** `formatUtcOffset`: `UTC+2`, `UTC-5:30`, `UTC`, the offset a zone is on at `atMs`. */
export const formatUtcOffset = (timeZone: string, atMs: number): string => {
	const part = Option.match(offsetFormatter(timeZone), {
		onNone: () => "GMT",
		onSome: (formatter) => formatter.formatToParts(atMs).find((entry) => entry.type === "timeZoneName")?.value ?? "GMT",
	})
	const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part)
	if (match === null) return "UTC"
	const [, sign, hours, minutes] = match
	return `UTC${sign}${Number(hours)}${minutes !== undefined && minutes !== "00" ? `:${minutes}` : ""}`
}

/** The footer mounted (the popover opened): its zone's offset now; a DST change shows on the next open. */
export const MountUtcOffset = Mount.define("MountTimeRangeUtcOffset", {
	args: { timeZone: Schema.String },
	messages: [Message.ResolvedUtcOffset],
	execute: ({ timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ResolvedUtcOffset({ timeZone, label: formatUtcOffset(timeZone, nowMs) })),
})

/** Marks the page-level picker's trigger, the one "D" opens. */
const HOTKEY_ATTRIBUTE = "time-range-hotkey"

type KeyPress = Readonly<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>

/** The `time.open` combo: a bare "D" (either case), no modifier held. */
export const isOpenKey = (event: KeyPress): boolean =>
	event.key.toLowerCase() === "d" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey

/**
 * `useAppHotkey("time.open", () => setOpen(true))`: "D" outside fields and dialogs, unmodified,
 * presses the page-level trigger while its popover is closed. Emits nothing itself.
 */
export const openOnHotkey = <A>(): Stream.Stream<A> =>
	Dom.streamFromEventFilterMap({
		target: () => document,
		type: "keydown",
		filterMapEvent: (event): Option.Option<A> => {
			if (!isOpenKey(event) || isEditableTarget(event.target) || isDialogOpen()) return Option.none()
			const trigger = document.querySelector(`[data-${HOTKEY_ATTRIBUTE}]`)
			if (!(trigger instanceof HTMLElement)) return Option.none()
			event.preventDefault()
			if (trigger.getAttribute("aria-expanded") !== "true") trigger.click()
			return Option.none()
		},
	})

/**
 * `TimezoneSelect`'s closed trigger, on the system zone.
 * TODO(timezone): the zone list (a searchable combobox) is not ported; the trigger is inert.
 */
const timezoneFooter = (h: HtmlBuilder<Message>, model: Model, timeZone: string): Html =>
	h.div(
		[h.Class("flex items-center justify-between gap-3 border-t border-border/70 bg-muted/20 px-4 py-2")],
		[
			eyebrow(h, {}, ["Timezone"]),
			h.button(
				[
					h.AriaLabel("Timezone"),
					h.AriaExpanded(false),
					h.AriaHasPopup("dialog"),
					h.Class(
						cn(
							"-mr-1.5 inline-flex h-6 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5",
							"text-2xs tracking-tight outline-none transition-colors",
							"hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/24 data-popup-open:bg-muted/60",
						),
					),
					h.DataAttribute("slot", "combobox-trigger"),
					h.Role("combobox"),
					h.Tabindex(0),
					h.Type("button"),
				],
				[
					icon(h, "GlobeIcon", { className: "size-3 shrink-0 text-muted-foreground/70" }),
					h.span([h.Class("truncate font-mono text-foreground/90")], [timeZone]),
					h.keyed("span")(
						`utc-offset-${timeZone}`,
						[h.Class("shrink-0 font-mono text-muted-foreground/70"), h.OnMount(MountUtcOffset({ timeZone }))],
						[model.utcOffset?.timeZone === timeZone ? model.utcOffset.label : ""],
					),
					h.span(
						[
							h.Class(cn(badgeVariants({ variant: "tag", className: "shrink-0" }))),
							h.DataAttribute("slot", "badge"),
						],
						["System"],
					),
					icon(h, "ChevronDownIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
				],
			),
		],
	)

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
	h.submodel({
		slotId: "time-range-popover",
		model: model.popover,
		view: Popover.view,
		toParentMessage: (message) => Message.GotPopoverMessage({ message }),
		viewInputs: {
			className:
				model.tab === "custom"
					? "w-auto max-w-[calc(100vw-1.5rem)] p-4"
					: "w-[520px] max-w-[calc(100vw-1.5rem)] p-0",
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
								attributes: [
									...trigger,
									...(inputs.hasHotkey === false
										? []
										: [h.Title("Time range (D)"), h.DataAttribute(HOTKEY_ATTRIBUTE, "")]),
								],
							},
							timeRangeTriggerContent(h, inputs.label),
						),
					),
				),
			toContent: () => [
				model.tab === "custom" && model.custom !== null
					? h.submodel({
							slotId: "custom-range",
							model: model.custom,
							view: CustomRangeView.view,
							viewInputs: {},
							toParentMessage: (message) =>
								Message.GotCustomRangeMessage({ message, ...withMax(inputs) }),
						})
					: h.div(
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
									[presetList(h, inputs)],
								),
								h.div(
									[h.Class("min-w-0 flex-1 space-y-5 p-4")],
									[shorthandInput(h, model, inputs), quickSelect(h, inputs)],
								),
							],
						),
						timezoneFooter(h, model, inputs.timeZone ?? "UTC"),
					],
				),
			],
		},
	}),
)
