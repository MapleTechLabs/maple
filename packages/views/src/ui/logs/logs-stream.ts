import { Array, Duration, Effect, Option, Record, Schema, Stream } from "effect"
import { Command, Dom, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as AttributesPanel from "../attributes/attributes-panel"
import { buildLogJsonPayload } from "./log-row-expanded"
import { LogRowView } from "./log-row-view"
import { Message, type NavigationKey, VirtualRow } from "./logs-stream-message"
import { CopyLogLink, CopyText, ScrollStreamToIndex, ScrollStreamToTop } from "./virtualize"

export { Message } from "./logs-stream-message"

// MODEL

export const ChipRef = Schema.Struct({ index: Schema.Number, key: Schema.String })
export type ChipRef = typeof ChipRef.Type

/**
 * One virtualized logs stream: its rows (derived by the parent and
 * handed over with `setRows` / `replaceRows`), the virtual window, keyboard focus, expanded rows,
 * the attribute card, and what the reader is inspecting. Rows live here rather than in `viewInputs`
 * because `h.submodel` walks `viewInputs` deeply on every render: O(rows) per scroll frame.
 */
export const Model = Schema.Struct({
	id: Schema.String,
	rows: Schema.Array(LogRowView),
	window: Schema.Array(VirtualRow),
	totalSize: Schema.Number,
	focusedIndex: Schema.Option(Schema.Number),
	expandedRows: Schema.Array(Schema.Number),
	isHovering: Schema.Boolean,
	isScrolledAway: Schema.Boolean,
	/** The attribute card on screen, and the chip whose rest-to-reveal delay is running. */
	visibleChip: Schema.Option(ChipRef),
	pendingOpen: Schema.Option(Schema.Struct({ chip: ChipRef, generation: Schema.Number })),
	pendingClose: Schema.Option(Schema.Number),
	chipGeneration: Schema.Number,
	/** Each expanded row's attribute panel, by row index. */
	panels: Schema.Record(Schema.String, AttributesPanel.Model),
	/** The expanded body's JSON copy: which row, and its status. */
	jsonCopy: AttributesPanel.CopyState,
})
export type Model = typeof Model.Type

export const init = (id: string, rows: ReadonlyArray<LogRowView>): Model => ({
	id,
	rows,
	window: [],
	totalSize: 0,
	focusedIndex: Option.none(),
	expandedRows: [],
	isHovering: false,
	isScrolledAway: false,
	visibleChip: Option.none(),
	pendingOpen: Option.none(),
	pendingClose: Option.none(),
	chipGeneration: 0,
	panels: {},
	jsonCopy: { id: "", status: "idle", generation: 0 },
})

/** The panels follow the expanded rows: a newly expanded row gets a fresh one, a collapsed one drops it. */
const syncPanels = (model: Model): Model => {
	const panels = Object.fromEntries(
		model.expandedRows.map((index) => [
			String(index),
			Option.getOrElse(Record.get(model.panels, String(index)), () =>
				AttributesPanel.init(`${model.id}-row-${index}-attributes`),
			),
		]),
	)
	const isSame =
		Object.keys(panels).length === Object.keys(model.panels).length &&
		Object.entries(panels).every(([key, panel]) => model.panels[key] === panel)
	return isSame ? model : modifyFields(model, { panels: () => panels })
}

// OUT MESSAGE

export const OutMessage = defineMessageUnion({
	/** A row was clicked or opened from the keyboard. */
	OpenedLog: { index: Schema.Number },
	/** The reader started or stopped inspecting (hovering, scrolled away, a row expanded). */
	ChangedInspecting: { isInspecting: Schema.Boolean, isScrolledAway: Schema.Boolean },
	/** Filter in / out from an attribute card. */
	ChoseAttributeFilter: {
		source: Schema.Literals(["log", "resource"]),
		key: Schema.String,
		value: Schema.String,
		negated: Schema.Boolean,
	},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

/** Rest-to-reveal, so sweeping the cursor along a row of chips opens nothing. */
export const CHIP_OPEN_DELAY = Duration.millis(300)
/** Grace period for crossing the gap between a chip and its card. */
export const CHIP_CLOSE_DELAY = Duration.millis(150)

export const WaitChipDelay = Command.define("WaitChipDelay", {
	args: { generation: Schema.Number, millis: Schema.Number },
	messages: [Message.ElapsedChipDelay],
	execute: ({ generation, millis }) =>
		Effect.sleep(Duration.millis(millis)).pipe(Effect.as(Message.ElapsedChipDelay({ generation }))),
})

const COPY_TIMEOUT = Duration.millis(2000)

export const WriteLogJson = Command.define("WriteLogJson", {
	args: { text: Schema.String, generation: Schema.Number },
	messages: [Message.SucceededCopyJson, Message.FailedCopyJson],
	execute: ({ text, generation }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
			Effect.as(Message.SucceededCopyJson({ generation })),
			Effect.orElseSucceed(() => Message.FailedCopyJson({ generation })),
		),
})

export const WaitLogJsonStatus = Command.define("WaitLogJsonStatus", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedCopyJsonStatus],
	execute: ({ generation }) =>
		Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(Message.ElapsedCopyJsonStatus({ generation }))),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const isInspecting = (model: Model) =>
	model.isHovering || model.isScrolledAway || model.expandedRows.length > 0

/** Runs a transition and reports the inspect state when it changed, once per transition. */
const reportingInspect = (before: Model, result: UpdateReturn): UpdateReturn => {
	const after = result.model
	if (isInspecting(before) === isInspecting(after) && before.isScrolledAway === after.isScrolledAway)
		return result
	return {
		...result,
		outMessage: OutMessage.ChangedInspecting({
			isInspecting: isInspecting(after),
			isScrolledAway: after.isScrolledAway,
		}),
	}
}

const sameChip = (a: ChipRef, b: ChipRef) => a.index === b.index && a.key === b.key
const isChip = (maybe: Option.Option<ChipRef>, chip: ChipRef) =>
	Option.exists(maybe, (c) => sameChip(c, chip))

const scheduleOpen = (model: Model, chip: ChipRef): UpdateReturn => {
	const generation = model.chipGeneration + 1
	return {
		model: modifyFields(model, {
			chipGeneration: () => generation,
			pendingOpen: () => Option.some({ chip, generation }),
			pendingClose: (pending) => (isChip(model.visibleChip, chip) ? Option.none() : pending),
		}),
		commands: [WaitChipDelay({ generation, millis: Duration.toMillis(CHIP_OPEN_DELAY) })],
	}
}

const scheduleClose = (model: Model): UpdateReturn => {
	const generation = model.chipGeneration + 1
	return {
		model: modifyFields(model, {
			chipGeneration: () => generation,
			pendingClose: () => Option.some(generation),
		}),
		commands: [WaitChipDelay({ generation, millis: Duration.toMillis(CHIP_CLOSE_DELAY) })],
	}
}

const closeChip = (model: Model, chip: ChipRef): Model =>
	modifyFields(model, {
		pendingOpen: (pending) =>
			Option.exists(pending, (p) => sameChip(p.chip, chip)) ? Option.none() : pending,
		visibleChip: (visible) => (isChip(visible, chip) ? Option.none() : visible),
		pendingClose: (pending) => (isChip(model.visibleChip, chip) ? Option.none() : pending),
	})

const closeCard = (model: Model): Model =>
	modifyFields(model, { visibleChip: () => Option.none(), pendingClose: () => Option.none() })

const toggled = (rows: ReadonlyArray<number>, index: number, expand: boolean | "toggle") => {
	const isOn = rows.includes(index)
	const on = expand === "toggle" ? !isOn : expand
	if (on === isOn) return rows
	return on ? [...rows, index] : rows.filter((row) => row !== index)
}

const navigate = (model: Model, key: NavigationKey, count: number): UpdateReturn => {
	const focused = Option.getOrElse(model.focusedIndex, () => -1)
	const moveTo = (index: number): UpdateReturn => ({
		model: modifyFields(model, { focusedIndex: () => Option.some(index) }),
		commands: [ScrollStreamToIndex({ streamId: model.id, index })],
	})
	switch (key) {
		case "Next":
			return count === 0 ? { model } : moveTo(focused < 0 ? 0 : Math.min(focused + 1, count - 1))
		case "Previous":
			return count === 0 ? { model } : moveTo(focused <= 0 ? 0 : focused - 1)
		case "Open":
			return focused < 0 ? { model } : { model, outMessage: OutMessage.OpenedLog({ index: focused }) }
		case "Expand":
		case "Collapse":
			return focused < 0
				? { model }
				: {
						model: modifyFields(model, {
							expandedRows: (rows) => toggled(rows, focused, key === "Expand"),
						}),
					}
		case "Clear":
			return { model: modifyFields(model, { focusedIndex: () => Option.none() }) }
	}
}

export const update = (model: Model, message: Message): UpdateReturn => {
	const result = handle(model, model.rows, message)
	return reportingInspect(model, { ...result, model: syncPanels(result.model) })
}

const jsonSettled = (model: Model, generation: number, status: "copied" | "error"): UpdateReturn =>
	generation === model.jsonCopy.generation
		? {
				model: modifyFields(model, { jsonCopy: (copy) => ({ ...copy, status }) }),
				commands: [WaitLogJsonStatus({ generation })],
			}
		: { model }

const panelMessage = (model: Model, index: number, message: AttributesPanel.Message): UpdateReturn =>
	Option.match(Record.get(model.panels, String(index)), {
		onNone: () => ({ model }),
		onSome: (panel) => {
			const result = AttributesPanel.update(panel, message)
			return {
				model: modifyFields(model, {
					panels: (panels) => Record.set(panels, String(index), result.model),
				}),
				commands: Command.mapMessages(result.commands ?? [], (inner) =>
					Message.GotPanelMessage({ index, message: inner }),
				),
				outMessage:
					result.outMessage === undefined
						? undefined
						: OutMessage.ChoseAttributeFilter(result.outMessage),
			}
		},
	})

const handle = (model: Model, rows: ReadonlyArray<LogRowView>, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ChangedVirtualWindow: ({ rows: rendered, totalSize }) => {
			// A chip that scrolled out of the window unmounts, taking its card along.
			const isRendered = (chip: ChipRef) => rendered.some((row) => row.index === chip.index)
			return {
				model: modifyFields(model, {
					window: () => rendered,
					totalSize: () => totalSize,
					visibleChip: (visible) => Option.filter(visible, isRendered),
					pendingOpen: (pending) => Option.filter(pending, (p) => isRendered(p.chip)),
				}),
			}
		},
		ChangedScrolledAway: ({ isScrolledAway }) => ({
			model: modifyFields(model, { isScrolledAway: () => isScrolledAway }),
		}),
		EnteredStream: () => ({ model: modifyFields(model, { isHovering: () => true }) }),
		LeftStream: () => ({ model: modifyFields(model, { isHovering: () => false }) }),
		ClickedRow: ({ index }) => ({ model, outMessage: OutMessage.OpenedLog({ index }) }),
		ClickedExpand: ({ index }) => ({
			model: modifyFields(model, { expandedRows: (rows) => toggled(rows, index, "toggle") }),
		}),
		ClickedCopyMessage: ({ index }) =>
			copy(
				model,
				Option.map(Array.get(rows, index), (row) => row.rawBody),
			),
		ClickedCopyLink: ({ index }) =>
			copyLink(
				model,
				Option.map(Array.get(rows, index), (row) => row.logKey),
			),
		PressedNavigationKey: ({ key }) => navigate(model, key, rows.length),
		EnteredChip: ({ index, key }) => scheduleOpen(model, { index, key }),
		FocusedChip: ({ index, key }) => scheduleOpen(model, { index, key }),
		LeftChip: ({ index, key }) => {
			const chip = { index, key }
			const cancelled = closeChipPending(model, chip)
			return isChip(model.visibleChip, chip) ? scheduleClose(cancelled) : { model: cancelled }
		},
		BlurredChip: ({ index, key }) => ({ model: closeChip(model, { index, key }) }),
		PressedChipEscape: ({ index, key }) => ({ model: closeChip(model, { index, key }) }),
		ClickedChip: ({ index, key }) =>
			copy(
				model,
				Option.flatMap(Array.get(rows, index), (row) =>
					Option.map(
						Array.findFirst(row.chips, (chip) => chip.key === key),
						(chip) => `${chip.key}=${chip.value}`,
					),
				),
			),
		EnteredChipCard: () => ({ model: modifyFields(model, { pendingClose: () => Option.none() }) }),
		LeftChipCard: () => (Option.isSome(model.visibleChip) ? scheduleClose(model) : { model }),
		ClickedChipFilter: ({ negated }) =>
			Option.match(model.visibleChip, {
				onNone: () => ({ model }),
				onSome: ({ index, key }) =>
					Option.match(
						Option.flatMap(Array.get(rows, index), (row) =>
							Array.findFirst(row.chips, (chip) => chip.key === key),
						),
						{
							onNone: () => ({ model: closeCard(model) }),
							onSome: ({ source, value }) => ({
								model: closeCard(model),
								outMessage: OutMessage.ChoseAttributeFilter({ source, key, value, negated }),
							}),
						},
					),
			}),
		ElapsedChipDelay: ({ generation }) => {
			const opening = Option.filter(model.pendingOpen, (p) => p.generation === generation)
			if (Option.isSome(opening))
				return {
					model: modifyFields(model, {
						visibleChip: () => Option.some(opening.value.chip),
						pendingOpen: () => Option.none(),
						pendingClose: () => Option.none(),
					}),
				}
			return Option.contains(model.pendingClose, generation) ? { model: closeCard(model) } : { model }
		},
		ClickedCardCopy: ({ part }) =>
			copy(
				model,
				Option.flatMap(model.visibleChip, ({ index, key }) =>
					part === "key"
						? Option.some(key)
						: Option.flatMap(Array.get(rows, index), (row) =>
								Option.map(
									Array.findFirst(row.chips, (chip) => chip.key === key),
									(chip) => chip.value,
								),
							),
				),
			),
		PlacedChipCard: () => ({ model }),
		CompletedCopy: () => ({ model }),
		ClickedDetails: ({ index }) => ({ model, outMessage: OutMessage.OpenedLog({ index }) }),
		ClickedCopyJson: ({ index }) =>
			Option.match(Array.get(rows, index), {
				onNone: () => ({ model }),
				onSome: (row) => {
					const generation = model.jsonCopy.generation + 1
					return {
						model: modifyFields(model, {
							jsonCopy: () => ({ id: String(index), status: "idle" as const, generation }),
						}),
						commands: [WriteLogJson({ text: buildLogJsonPayload(row.log), generation })],
					}
				},
			}),
		SucceededCopyJson: ({ generation }) => jsonSettled(model, generation, "copied"),
		FailedCopyJson: ({ generation }) => jsonSettled(model, generation, "error"),
		ElapsedCopyJsonStatus: ({ generation }) =>
			generation === model.jsonCopy.generation
				? {
						model: modifyFields(model, {
							jsonCopy: (copy) => ({ ...copy, status: "idle" as const }),
						}),
					}
				: { model },
		GotPanelMessage: ({ index, message: inner }) => panelMessage(model, index, inner),
		CompletedScroll: () => ({ model }),
	})

const closeChipPending = (model: Model, chip: ChipRef): Model =>
	modifyFields(model, {
		pendingOpen: (pending) =>
			Option.exists(pending, (p) => sameChip(p.chip, chip)) ? Option.none() : pending,
	})

const copy = (model: Model, text: Option.Option<string>): UpdateReturn =>
	Option.match(text, {
		onNone: () => ({ model }),
		onSome: (value) => ({ model, commands: [CopyText({ text: value })] }),
	})

const copyLink = (model: Model, logKey: Option.Option<string>): UpdateReturn =>
	Option.match(logKey, {
		onNone: () => ({ model }),
		onSome: (key) => ({ model, commands: [CopyLogLink({ logKey: key })] }),
	})

// PARENT ENTRY POINTS

/** The same logs, derived again (a pinned column or the search changed). */
export const setRows = (model: Model, rows: ReadonlyArray<LogRowView>): UpdateReturn => ({
	model: modifyFields(model, { rows: () => rows }),
})

/** New data (a reload that prepends rows, a filter): expansion was made on the old rows, so it goes. */
export const replaceRows = (model: Model, rows: ReadonlyArray<LogRowView>): UpdateReturn =>
	reportingInspect(model, {
		model: modifyFields(model, { rows: () => rows, expandedRows: () => [], panels: () => ({}) }),
	})

/** "Jump to latest": back to the newest rows, every row collapsed. */
export const jumpToLatest = (model: Model): UpdateReturn =>
	reportingInspect(model, {
		model: modifyFields(model, {
			expandedRows: () => [],
			panels: () => ({}),
			isScrolledAway: () => false,
		}),
		commands: [ScrollStreamToTop({ streamId: model.id })],
	})

// SUBSCRIPTION

const isTyping = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	(target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null)

const isInteractive = (target: EventTarget | null) =>
	target instanceof HTMLElement &&
	target.closest("button, a, [role='button'], [role='menuitem'], [role='option']") !== null

const KEYS = new Map<string, NavigationKey>([
	["j", "Next"],
	["J", "Next"],
	["ArrowDown", "Next"],
	["k", "Previous"],
	["K", "Previous"],
	["ArrowUp", "Previous"],
	["ArrowRight", "Expand"],
	["ArrowLeft", "Collapse"],
	["Escape", "Clear"],
	["Enter", "Open"],
])

/** `useListNavigation` (j/k/↑/↓, Enter, Escape) plus the stream's →/← expand hotkeys. */
export const navigationKeys: Stream.Stream<Message> = Dom.streamFromEventFilterMapPreventDefault({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event) => {
		const key = KEYS.get(event.key)
		if (key === undefined || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target))
			return Option.none()
		if (key === "Open" && isInteractive(event.target)) return Option.none()
		return Option.some(Message.PressedNavigationKey({ key }))
	},
})
