import { Array, Duration, Effect, Layer, Option, Record, Schema, Stream } from "effect"
import { Block, Dom, Update } from "foldkit"
import { makeInitIfMissingStep } from "foldkit/bindingInit"
import { modifyFields } from "foldkit/struct"
import { buildLogJsonPayload } from "./log-row-expanded"
import type { LogRowView } from "./log-row-view"
import { LogsStreamComposition, PanelsBinding } from "./logs-stream-composition"
import {
	type ChipRef,
	LogsStreamDefinition,
	makeFieldsStep,
	makeStep,
	Model,
	OutMessage,
} from "./logs-stream-definition"
import { Message, type NavigationKey } from "./logs-stream-message"
import { view } from "./logs-stream-view"
import { PlaceChipCard } from "./chip-card"
import {
	CopyLogLink,
	CopyText,
	ScrollStreamToIndex,
	ScrollStreamToTop,
	VirtualizeLogStream,
} from "./virtualize"

export { Message } from "./logs-stream-message"
export { ChipRef, Model, OutMessage } from "./logs-stream-definition"

// INIT

const init = LogsStreamComposition.makeInit((id: string, rows: ReadonlyArray<LogRowView>) => ({
	model: {
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
	},
}))

const panelIdOf = (streamId: string, index: number) => `${streamId}-row-${index}-attributes`

// COMMAND

/** Rest-to-reveal, so sweeping the cursor along a row of chips opens nothing. */
export const CHIP_OPEN_DELAY = Duration.millis(300)
/** Grace period for crossing the gap between a chip and its card. */
export const CHIP_CLOSE_DELAY = Duration.millis(150)

export const WaitChipDelay = LogsStreamDefinition.makeCommand("WaitChipDelay", {
	args: { generation: Schema.Number, millis: Schema.Number },
	messages: [Message.ElapsedChipDelay],
	handler: function* () {
		return ({ generation, millis }) =>
			Effect.sleep(Duration.millis(millis)).pipe(Effect.as(Message.ElapsedChipDelay({ generation })))
	},
})

const COPY_TIMEOUT = Duration.millis(2000)

export const WriteLogJson = LogsStreamDefinition.makeCommand("WriteLogJson", {
	args: { text: Schema.String, generation: Schema.Number },
	messages: [Message.SucceededCopyJson, Message.FailedCopyJson],
	handler: function* () {
		return ({ text, generation }) =>
			Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
				Effect.as(Message.SucceededCopyJson({ generation })),
				Effect.orElseSucceed(() => Message.FailedCopyJson({ generation })),
			)
	},
})

export const WaitLogJsonStatus = LogsStreamDefinition.makeCommand("WaitLogJsonStatus", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedCopyJsonStatus],
	handler: function* () {
		return ({ generation }) =>
			Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(Message.ElapsedCopyJsonStatus({ generation })))
	},
})

// UPDATE

const isInspecting = (model: Model) =>
	model.isHovering || model.isScrolledAway || model.expandedRows.length > 0

/** The inspect state to report when a transition changed it, once per transition. */
const inspectChange = (before: Model, after: Model): OutMessage | undefined =>
	isInspecting(before) === isInspecting(after) && before.isScrolledAway === after.isScrolledAway
		? undefined
		: OutMessage.ChangedInspecting({
				isInspecting: isInspecting(after),
				isScrolledAway: after.isScrolledAway,
			})

/** A plain transition with its inspect change attached. */
const reportingInspect = <const Result extends Readonly<{ model: Model }>>(before: Model, result: Result) =>
	Update.withOutMessage(result, inspectChange(before, result.model))

const sameChip = (a: ChipRef, b: ChipRef) => a.index === b.index && a.key === b.key
const isChip = (maybe: Option.Option<ChipRef>, chip: ChipRef) =>
	Option.exists(maybe, (c) => sameChip(c, chip))

const scheduleOpen = (model: Model, chip: ChipRef) => {
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

const scheduleClose = (model: Model) => {
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

/**
 * Expands, collapses or toggles one row. The panels follow the expanded rows: a newly expanded row
 * gets a fresh one, a collapsed one drops it.
 */
const expandStep = makeStep((model: Model, index: number, expand: boolean | "toggle") => {
	const expandedRows = toggled(model.expandedRows, index, expand)
	if (expandedRows === model.expandedRows) return { model }
	if (!expandedRows.includes(index))
		return {
			model: modifyFields(model, {
				expandedRows: () => expandedRows,
				panels: (panels) => Record.remove(panels, String(index)),
			}),
		}
	return Update.combineSteps([
		makeFieldsStep(() => ({ expandedRows: () => expandedRows })),
		makeInitIfMissingStep(PanelsBinding, { key: String(index), args: [panelIdOf(model.id, index)] }),
	])
})

/** The inspect change an `expandStep` makes: only its expanded rows move. */
const expandInspect = (model: Model, index: number, expand: boolean | "toggle") =>
	inspectChange(model, modifyFields(model, { expandedRows: (rows) => toggled(rows, index, expand) }))

/** Keyboard navigation other than expanding or collapsing the focused row. */
const navigateStep = makeStep((model: Model, key: NavigationKey) => {
	const count = model.rows.length
	const focused = Option.getOrElse(model.focusedIndex, () => -1)
	const moveTo = (index: number) => ({
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
			return { model }
		case "Clear":
			return { model: modifyFields(model, { focusedIndex: () => Option.none() }) }
	}
})

const jsonSettled = (model: Model, generation: number, status: "copied" | "error") =>
	generation === model.jsonCopy.generation
		? {
				model: modifyFields(model, { jsonCopy: (copy) => ({ ...copy, status }) }),
				commands: [WaitLogJsonStatus({ generation })],
			}
		: { model }

const update = LogsStreamComposition.makeUpdate({
	ChangedVirtualWindow: (model, { rows: rendered, totalSize }) => {
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
	ChangedScrolledAway: (model, { isScrolledAway }) =>
		reportingInspect(model, { model: modifyFields(model, { isScrolledAway: () => isScrolledAway }) }),
	EnteredStream: (model) =>
		reportingInspect(model, { model: modifyFields(model, { isHovering: () => true }) }),
	LeftStream: (model) =>
		reportingInspect(model, { model: modifyFields(model, { isHovering: () => false }) }),
	ClickedRow: (model, { index }) => ({ model, outMessage: OutMessage.OpenedLog({ index }) }),
	ClickedExpand: (model, { index }) =>
		Update.withOutMessage(expandStep(model, index, "toggle"), expandInspect(model, index, "toggle")),
	ClickedCopyMessage: (model, { index }) =>
		copy(
			model,
			Option.map(Array.get(model.rows, index), (row) => row.rawBody),
		),
	ClickedCopyLink: (model, { index }) =>
		copyLink(
			model,
			Option.map(Array.get(model.rows, index), (row) => row.logKey),
		),
	PressedNavigationKey: (model, { key }) => {
		const focused = Option.getOrElse(model.focusedIndex, () => -1)
		const expand = key === "Expand"
		return (key === "Expand" || key === "Collapse") && focused >= 0
			? Update.withOutMessage(expandStep(model, focused, expand), expandInspect(model, focused, expand))
			: navigateStep(model, key)
	},
	EnteredChip: (model, { index, key }) => scheduleOpen(model, { index, key }),
	FocusedChip: (model, { index, key }) => scheduleOpen(model, { index, key }),
	LeftChip: (model, { index, key }) => {
		const chip = { index, key }
		const cancelled = closeChipPending(model, chip)
		return isChip(model.visibleChip, chip) ? scheduleClose(cancelled) : { model: cancelled }
	},
	BlurredChip: (model, { index, key }) => ({ model: closeChip(model, { index, key }) }),
	PressedChipEscape: (model, { index, key }) => ({ model: closeChip(model, { index, key }) }),
	ClickedChip: (model, { index, key }) =>
		copy(
			model,
			Option.flatMap(Array.get(model.rows, index), (row) =>
				Option.map(
					Array.findFirst(row.chips, (chip) => chip.key === key),
					(chip) => `${chip.key}=${chip.value}`,
				),
			),
		),
	EnteredChipCard: (model) => ({ model: modifyFields(model, { pendingClose: () => Option.none() }) }),
	LeftChipCard: (model) => (Option.isSome(model.visibleChip) ? scheduleClose(model) : { model }),
	ClickedChipFilter: (model, { negated }) =>
		Option.match(model.visibleChip, {
			onNone: () => ({ model }),
			onSome: ({ index, key }) =>
				Option.match(
					Option.flatMap(Array.get(model.rows, index), (row) =>
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
	ElapsedChipDelay: (model, { generation }) => {
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
	ClickedCardCopy: (model, { part }) =>
		copy(
			model,
			Option.flatMap(model.visibleChip, ({ index, key }) =>
				part === "key"
					? Option.some(key)
					: Option.flatMap(Array.get(model.rows, index), (row) =>
							Option.map(
								Array.findFirst(row.chips, (chip) => chip.key === key),
								(chip) => chip.value,
							),
						),
			),
		),
	PlacedChipCard: (model) => ({ model }),
	CompletedCopy: (model) => ({ model }),
	ClickedDetails: (model, { index }) => ({ model, outMessage: OutMessage.OpenedLog({ index }) }),
	ClickedCopyJson: (model, { index }) =>
		Option.match(Array.get(model.rows, index), {
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
	SucceededCopyJson: (model, { generation }) => jsonSettled(model, generation, "copied"),
	FailedCopyJson: (model, { generation }) => jsonSettled(model, generation, "error"),
	ElapsedCopyJsonStatus: (model, { generation }) =>
		generation === model.jsonCopy.generation
			? {
					model: modifyFields(model, {
						jsonCopy: (copy) => ({ ...copy, status: "idle" as const }),
					}),
				}
			: { model },
	CompletedScroll: (model) => ({ model }),
	InformedOfRows: (model, { rows }) => ({ model: modifyFields(model, { rows: () => rows }) }),
	InformedOfReplacedRows: (model, { rows }) =>
		reportingInspect(model, {
			model: modifyFields(model, { rows: () => rows, expandedRows: () => [], panels: () => ({}) }),
		}),
	RequestedJumpToLatest: (model) => {
		const latest = modifyFields(model, {
			expandedRows: () => [],
			panels: () => ({}),
			isScrolledAway: () => false,
		})
		return Update.withOutMessage(
			{ model: latest, commands: [ScrollStreamToTop({ streamId: model.id })] },
			inspectChange(model, latest),
		)
	},
})

const closeChipPending = (model: Model, chip: ChipRef): Model =>
	modifyFields(model, {
		pendingOpen: (pending) =>
			Option.exists(pending, (p) => sameChip(p.chip, chip)) ? Option.none() : pending,
	})

const copy = (model: Model, text: Option.Option<string>) =>
	Option.match(text, {
		onNone: () => ({ model }),
		onSome: (value) => ({ model, commands: [CopyText({ text: value })] }),
	})

const copyLink = (model: Model, logKey: Option.Option<string>) =>
	Option.match(logKey, {
		onNone: () => ({ model }),
		onSome: (key) => ({ model, commands: [CopyLogLink({ logKey: key })] }),
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
const navigationKeys: Stream.Stream<typeof Message.PressedNavigationKey.Type> =
	Dom.streamFromEventFilterMapPreventDefault({
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

export const subscriptions = LogsStreamDefinition.makeSubscriptions((entry) => ({
	/** `useListNavigation` and the →/← expand hotkeys, while the stream has rows. */
	navigationKeys: entry("LogsStreamNavigationKeys", {
		messages: [Message.PressedNavigationKey],
		when: (model) => model.rows.length > 0,
		handler: function* () {
			return () => navigationKeys
		},
	}),
}))

// BLOCK

const prepare = () =>
	LogsStreamComposition.prepareBlock({
		init,
		update,
		view,
		subscriptions,
		operations: {
			/** The same logs, derived again (a pinned column or the search changed). */
			informRows: Message.InformedOfRows,
			/** New data: expansion was made on the old rows, so it goes. */
			informReplacedRows: Message.InformedOfReplacedRows,
			requestJumpToLatest: Message.RequestedJumpToLatest,
		},
		EffectsLayer: Layer.mergeAll(
			WaitChipDelay.layer,
			WriteLogJson.layer,
			WaitLogJsonStatus.layer,
			ScrollStreamToIndex.layer,
			ScrollStreamToTop.layer,
			CopyText.layer,
			CopyLogLink.layer,
			VirtualizeLogStream.layer,
			PlaceChipCard.layer,
			subscriptions.layer,
		),
	})
export const LogsStreamBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
