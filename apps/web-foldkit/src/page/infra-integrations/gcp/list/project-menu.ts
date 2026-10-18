import { Command } from "foldkit"
import type { Resources } from "../../../../platform/resources"
import * as Menu from "../../../../ui/menu"
import { Message } from "./model"
import { ALL_PROJECTS, MANAGE_CONNECTIONS } from "./view-project-menu"

// The project menu's update, shared by the page and the lab: a radio pick closes the menu
// (`closeOnClick`) and names the project; "Manage connections" leaves for the integration.

export type ProjectPick =
	| Readonly<{ _tag: "Project"; project: string | undefined }>
	| Readonly<{ _tag: "ManageConnections" }>

export type ProjectMenuStep = Readonly<{
	menu: Menu.Model
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
	pick: ProjectPick | null
}>

const wrap = (commands: ReadonlyArray<Command.Command<Menu.Message, never, Resources>> | undefined) =>
	Command.mapMessages(commands ?? [], (message) => Message.GotProjectMenuMessage({ message }))

export const stepProjectMenu = (menu: Menu.Model, message: Menu.Message): ProjectMenuStep => {
	const step = Menu.update(menu, message)
	const out = step.outMessage
	if (out?._tag === "SelectedRadio") {
		const closed = Menu.update(step.model, Menu.Message.PressedOutside())
		return {
			menu: closed.model,
			commands: [...wrap(step.commands), ...wrap(closed.commands)],
			pick: { _tag: "Project", project: out.value === ALL_PROJECTS ? undefined : out.value },
		}
	}
	const pick: ProjectPick | null =
		out?._tag === "SelectedItem" && out.value === MANAGE_CONNECTIONS
			? { _tag: "ManageConnections" }
			: null
	return { menu: step.model, commands: wrap(step.commands), pick }
}
