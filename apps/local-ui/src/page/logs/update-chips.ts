import * as Tooltip from "@maple/web/ui/tooltip"
import { Duration, Effect, Option, Record, Schema } from "effect"
import { Command } from "foldkit"
import { Message } from "./message"
import { CHIP_JSON_COPY_ID, type ChipCard, type ChipRef, initChipJsonTooltip, type Model } from "./model"
import type { UpdateReturn } from "./update"

// `LogAttributeChip`'s hover card: rest 300 ms to open, 150 ms of grace to cross into the card.

const OPEN_DELAY_MS = 300
const CLOSE_DELAY_MS = 150

export const WaitChipDelay = Command.define("WaitLocalLogChipDelay", {
	args: { generation: Schema.Number, millis: Schema.Number },
	messages: [Message.ElapsedChipDelay],
	execute: ({ generation, millis }) =>
		Effect.as(Effect.sleep(Duration.millis(millis)), Message.ElapsedChipDelay({ generation })),
})

const sameChip = (a: ChipRef, b: ChipRef) => a.index === b.index && a.logKey === b.logKey && a.key === b.key
const isChip = (maybe: Option.Option<ChipRef>, chip: ChipRef) =>
	Option.exists(maybe, (other) => sameChip(other, chip))

const isSameVisible = (a: Option.Option<ChipRef>, b: Option.Option<ChipRef>) =>
	Option.isNone(a) ? Option.isNone(b) : Option.isSome(b) && sameChip(a.value, b.value)

/** Another card (or none) unmounts the last one: its JSON view, copy status and tooltip start over. */
export const withCard = (model: Model, chipCard: ChipCard): Model =>
	isSameVisible(model.chipCard.visible, chipCard.visible)
		? { ...model, chipCard }
		: {
				...model,
				chipCard: { ...chipCard, isJsonExpanded: false },
				chipJsonTooltip: initChipJsonTooltip(),
				copies: Record.remove(model.copies, CHIP_JSON_COPY_ID),
			}

export const toggleChipJson = (model: Model): UpdateReturn => ({
	model: { ...model, chipCard: { ...model.chipCard, isJsonExpanded: !model.chipCard.isJsonExpanded } },
})

export const updateChipJsonTooltip = (model: Model, message: Tooltip.Message): UpdateReturn => {
	const next = Tooltip.update(model.chipJsonTooltip, message)
	return {
		model: { ...model, chipJsonTooltip: next.model },
		commands: Command.mapMessages(next.commands ?? [], (tip) =>
			Message.GotChipJsonTooltipMessage({ message: tip }),
		),
	}
}

const schedule = (model: Model, card: ChipCard, millis: number): UpdateReturn => ({
	model: withCard(model, card),
	commands: [WaitChipDelay({ generation: card.generation, millis })],
})

export const scheduleOpen = (model: Model, chip: ChipRef): UpdateReturn => {
	const card = model.chipCard
	const generation = card.generation + 1
	return schedule(
		model,
		{
			...card,
			generation,
			pendingOpen: Option.some({ chip, generation }),
			pendingClose: isChip(card.visible, chip) ? Option.none() : card.pendingClose,
		},
		OPEN_DELAY_MS,
	)
}

const scheduleClose = (model: Model, card: ChipCard): UpdateReturn => {
	const generation = card.generation + 1
	return schedule(model, { ...card, generation, pendingClose: Option.some(generation) }, CLOSE_DELAY_MS)
}

const dropPendingOpen = (card: ChipCard, chip: ChipRef): ChipCard => ({
	...card,
	pendingOpen: Option.filter(card.pendingOpen, (pending) => !sameChip(pending.chip, chip)),
})

/** The pointer left the chip: a pending open is dropped, a shown card gets its grace period. */
export const leaveChip = (model: Model, chip: ChipRef): UpdateReturn => {
	const card = dropPendingOpen(model.chipCard, chip)
	return isChip(card.visible, chip) ? scheduleClose(model, card) : { model: withCard(model, card) }
}

/** Blur and Escape close at once. */
export const closeChip = (model: Model, chip: ChipRef): UpdateReturn => {
	const card = dropPendingOpen(model.chipCard, chip)
	return isChip(card.visible, chip)
		? { model: withCard(model, { ...card, visible: Option.none(), pendingClose: Option.none() }) }
		: { model: withCard(model, card) }
}

export const enterCard = (model: Model): UpdateReturn => ({
	model: withCard(model, { ...model.chipCard, pendingClose: Option.none() }),
})

export const leaveCard = (model: Model): UpdateReturn =>
	Option.isSome(model.chipCard.visible) ? scheduleClose(model, model.chipCard) : { model }

/** A delay ran out: open the chip it was for, or close the card if it is the latest close. */
export const elapseDelay = (model: Model, generation: number): UpdateReturn => {
	const card = model.chipCard
	const opening = Option.filter(card.pendingOpen, (pending) => pending.generation === generation)
	if (Option.isSome(opening))
		return {
			model: withCard(model, {
				...card,
				visible: Option.some(opening.value.chip),
				pendingOpen: Option.none(),
				pendingClose: Option.none(),
			}),
		}
	return Option.contains(card.pendingClose, generation)
		? { model: withCard(model, { ...card, visible: Option.none(), pendingClose: Option.none() }) }
		: { model }
}
