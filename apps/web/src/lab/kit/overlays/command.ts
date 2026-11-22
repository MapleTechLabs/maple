import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Combobox from "@maple/views/ui/combobox"
import {
	type CommandGroup,
	commandFooter,
	commandHiddenInput,
	commandHints,
	commandInput,
	commandList,
	MeasureCommandList,
} from "@maple/views/ui/command"
import type * as Dialog from "@maple/views/ui/dialog"
import { view as dialogView } from "@maple/views/ui/dialog-view"
import { Message } from "./model"

// The command palette, open on mount.
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
				commandList(h, list, COMMANDS, toMessage, {
					viewportAttributes: [
						h.OnMount(
							Mount.mapMessage(MeasureCommandList(), () =>
								Message.CompletedMeasureCommandList(),
							),
						),
					],
					hasMeasuredScrollbar: true,
				}),
				commandFooter(h, commandHints(h)),
				commandHiddenInput(h, list),
			],
		},
		toParentMessage: (message) => Message.GotCommandMessage({ message }),
	})
}
