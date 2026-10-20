import { Option } from "effect"
import { Command } from "foldkit"
import * as Menu from "../../../ui/menu"
import type { Message } from "./message"

/** One menu step: its next state, its commands, and the item it just picked (if any). */
export const menuStep = (
	menu: Menu.Model,
	message: Menu.Message,
	wrap: (message: Menu.Message) => Message,
): {
	model: Menu.Model
	commands: ReadonlyArray<Command.Command<Message>>
	picked: Option.Option<string>
} => {
	const next = Menu.update(menu, message)
	const out = next.outMessage
	return {
		model: next.model,
		commands: Command.mapMessages(next.commands ?? [], wrap),
		picked: out === undefined ? Option.none() : Option.some(out.value),
	}
}
