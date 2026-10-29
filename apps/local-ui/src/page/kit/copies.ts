import { type CopyButtonOptions, CopyStatus, copyButton, writeClipboard } from "@maple/web/ui/copy-button"
import { Duration, Effect, Layer, Option, Record, Schema } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"

/**
 * Every copy button a view shows, by id: the owning Model keeps them in one record and folds
 * `CopyMessage` through `updateCopy`. Each id behaves like `CopyButtonBlock`: copy writes the
 * clipboard, holds `copied`/`error` for the timeout, then falls back to `idle`.
 */

const COPY_TIMEOUT = Duration.millis(2000)

/** One copy button's state; a newer copy bumps `generation` so an older reset is dropped. */
export const CopyState = Schema.Struct({ status: CopyStatus, generation: Schema.Finite })
export type CopyState = typeof CopyState.Type

export const Copies = Schema.Record(Schema.String, CopyState)
export type Copies = typeof Copies.Type

const IDLE: CopyState = { status: "idle", generation: 0 }

export const copyOf = (copies: Copies, id: string): CopyState =>
	Option.getOrElse(Record.get(copies, id), () => IDLE)

/** The copy facts of one id; the owner carries them in one Message variant and folds them with `updateCopy`. */
export const CopyMessage = defineMessageUnion({
	ClickedCopy: { id: Schema.String, text: Schema.String },
	SucceededCopy: { id: Schema.String, generation: Schema.Finite },
	FailedCopy: { id: Schema.String, generation: Schema.Finite },
	ElapsedCopyStatus: { id: Schema.String, generation: Schema.Finite },
})
export type CopyMessage = typeof CopyMessage.Type

export const WriteCopy = Command.define("WriteCopy", {
	args: { id: Schema.String, text: Schema.String, generation: Schema.Finite },
	messages: [CopyMessage.SucceededCopy, CopyMessage.FailedCopy],
	handler: function* () {
		return ({ id, text, generation }) =>
			Effect.map(writeClipboard(text), (ok) =>
				ok
					? CopyMessage.SucceededCopy({ id, generation })
					: CopyMessage.FailedCopy({ id, generation }),
			)
	},
})

export const WaitCopyReset = Command.define("WaitCopyReset", {
	args: { id: Schema.String, generation: Schema.Finite },
	messages: [CopyMessage.ElapsedCopyStatus],
	handler: function* () {
		return ({ id, generation }) =>
			Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(CopyMessage.ElapsedCopyStatus({ id, generation })))
	},
})

/** The handlers `updateCopy`'s Commands need: merge into the owning Block's `EffectsLayer`. */
export const EffectsLayer = Layer.mergeAll(WriteCopy.layer, WaitCopyReset.layer)

type CopyCommand = ReturnType<typeof WriteCopy> | ReturnType<typeof WaitCopyReset>

type CopyStep = Readonly<{ copies: Copies; commands: ReadonlyArray<CopyCommand> }>

const settled = (copies: Copies, id: string, generation: number, status: CopyStatus): CopyStep =>
	generation === copyOf(copies, id).generation
		? {
				copies: Record.set(copies, id, { status, generation }),
				commands: [WaitCopyReset({ id, generation })],
			}
		: { copies, commands: [] }

const step = (copies: Copies, message: CopyMessage): CopyStep =>
	CopyMessage.match<CopyStep>(message, {
		ClickedCopy: ({ id, text }) => {
			const generation = copyOf(copies, id).generation + 1
			const bumped = Record.set(copies, id, { ...copyOf(copies, id), generation })
			// An empty value fails without touching the clipboard.
			return text === ""
				? settled(bumped, id, generation, "error")
				: { copies: bumped, commands: [WriteCopy({ id, text, generation })] }
		},
		SucceededCopy: ({ id, generation }) => settled(copies, id, generation, "copied"),
		FailedCopy: ({ id, generation }) => settled(copies, id, generation, "error"),
		ElapsedCopyStatus: ({ id, generation }) =>
			generation === copyOf(copies, id).generation
				? { copies: Record.set(copies, id, { status: "idle", generation }), commands: [] }
				: { copies, commands: [] },
	})

/** Folds one copy fact; `toMessage` lifts its Commands back into the owner's Message. */
export const updateCopy = <M>(
	copies: Copies,
	message: CopyMessage,
	toMessage: (message: CopyMessage) => M,
) => {
	const next = step(copies, message)
	return { copies: next.copies, commands: Command.mapMessages(next.commands, toMessage) }
}

export type CopiesButtonOptions<M> = Omit<CopyButtonOptions<M>, "status" | "onClick"> &
	Readonly<{
		copies: Copies
		id: string
		/** The text a click copies. */
		value: string
		toMessage: (message: CopyMessage) => M
	}>

/** `<CopyButton>` for one id of a `Copies` record: the replacement for the old `CopyButton.view`. */
export const copiesButton = <M>(h: HtmlBuilder<M>, options: CopiesButtonOptions<M>): Html => {
	const { copies, id, value, toMessage, ...rest } = options
	return copyButton(h, {
		...rest,
		status: copyOf(copies, id).status,
		onClick: toMessage(CopyMessage.ClickedCopy({ id, text: value })),
	})
}
