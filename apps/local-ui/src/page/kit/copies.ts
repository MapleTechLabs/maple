import * as CopyButton from "@maple/web/ui/copy-button"
import { Option, Record, Schema } from "effect"
import { Command, type Update } from "foldkit"

/**
 * Every copy button a view shows, by id: the owning Model keeps them in one record and folds `CopyButton.update` by id.
 */
export const Copies = Schema.Record(Schema.String, CopyButton.Model)
export type Copies = typeof Copies.Type

export const copyOf = (copies: Copies, id: string): CopyButton.Model =>
	Option.getOrElse(Record.get(copies, id), CopyButton.init)

/** Folds one copy button's Message; `toMessage` lifts its Commands back to the owner. */
export const updateCopy = <M>(
	copies: Copies,
	id: string,
	message: CopyButton.Message,
	toMessage: (id: string, message: CopyButton.Message) => M,
): Readonly<{ copies: Copies; commands: ReadonlyArray<Command.Command<M>> }> => {
	const next: Update.Return<CopyButton.Model, CopyButton.Message> = CopyButton.update(copyOf(copies, id), message)
	return {
		copies: Record.set(copies, id, next.model),
		commands: Command.mapMessages(next.commands ?? [], (child) => toMessage(id, child)),
	}
}
