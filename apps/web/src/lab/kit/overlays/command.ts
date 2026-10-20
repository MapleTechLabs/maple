import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Combobox from "../../../ui/combobox"
import {
	type CommandGroup,
	commandFooter,
	commandHiddenInput,
	commandInput,
	commandList,
} from "../../../ui/command"
import type * as Dialog from "../../../ui/dialog"
import { view as dialogView } from "../../../ui/dialog-view"
import { kbd } from "../../../ui/display"
import { Message } from "./model"

// `KitCommand`: the command palette, open on mount.
type H = HtmlBuilder<Message>

export const COMMANDS: ReadonlyArray<CommandGroup> = [
	{
		label: "Pages",
		items: [
			{ title: "Overview", shortcut: "G O" },
			{ title: "Traces", shortcut: "G T" },
			{ title: "Logs", shortcut: "G L" },
		],
	},
	{ label: "Actions", items: [{ title: "Create dashboard" }, { title: "Invite teammate" }] },
]

const hint = (h: H, key: string, text: string): Html =>
	h.span([h.Class("flex items-center gap-1.5")], [kbd(h, undefined, [key]), text])

export const kitCommand = (h: H, dialog: Dialog.Model, list: Combobox.Model): Html => {
	const toMessage = (message: Combobox.Message) => Message.GotCommandListMessage({ message })
	return h.submodel({
		slotId: "command",
		model: dialog,
		view: dialogView,
		viewInputs: {
			hasTrigger: false,
			toView: ({ portal }) => h.div([h.Class("flex min-h-48 items-start")], [portal]),
			toContent: () => [
				commandInput(
					h,
					list,
					{ placeholder: "Search pages, dashboards, actions", groups: COMMANDS },
					toMessage,
				),
				commandList(h, list, COMMANDS, toMessage),
				commandFooter(h, [hint(h, "Enter", " to open"), hint(h, "Esc", " to close")]),
				commandHiddenInput(h, list),
			],
		},
		toParentMessage: (message) => Message.GotCommandMessage({ message }),
	})
}
