import { Array as Arr, Option, Schema, String as Str } from "effect"
import { Command as FoldkitCommand } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "@maple/views/ui/dialog"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import { pressable } from "@maple/views/ui/pressable"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { cn } from "@maple/ui/lib/utils"
import { textField } from "./fields"

// The Group dialog of a component: one click puts it in a group the page already has (or in none),
// and a name typed below creates a group. The builder and Settings > Monitors share it.

export const GroupDialog = Schema.Struct({
	dialog: Dialog.Model,
	/** A new group's name, as typed. */
	draft: Schema.String,
})
export type GroupDialog = typeof GroupDialog.Type

export const initGroupDialog = (id: string): GroupDialog => ({
	dialog: Dialog.init(id, "dialog"),
	draft: "",
})

export const GroupDialogMessage = defineMessageUnion({
	ClickedOpen: {},
	GotDialogMessage: { message: Dialog.Message },
	/** An existing group, or `""` for none. */
	PickedGroup: { group: Schema.String },
	ChangedDraft: { value: Schema.String },
	SubmittedDraft: {},
})
export type GroupDialogMessage = typeof GroupDialogMessage.Type

export type GroupDialogStep = Readonly<{
	state: GroupDialog
	commands: ReadonlyArray<FoldkitCommand.Command<GroupDialogMessage>>
	/** The group the component goes in, `""` for none, once one is picked or created. */
	picked: Option.Option<string>
}>

const wrap = (step: ReturnType<typeof Dialog.update>) =>
	FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		GroupDialogMessage.GotDialogMessage({ message }),
	)

const closeWith = (state: GroupDialog, group: string): GroupDialogStep => {
	const step = Dialog.close(state.dialog)
	return { state: { dialog: step.model, draft: "" }, commands: wrap(step), picked: Option.some(group) }
}

export const updateGroupDialog = (state: GroupDialog, message: GroupDialogMessage): GroupDialogStep =>
	GroupDialogMessage.match<GroupDialogStep>(message, {
		ClickedOpen: () => {
			const step = Dialog.open(state.dialog)
			return { state: { dialog: step.model, draft: "" }, commands: wrap(step), picked: Option.none() }
		},
		GotDialogMessage: ({ message: child }) => {
			const step = Dialog.update(state.dialog, child)
			return { state: { ...state, dialog: step.model }, commands: wrap(step), picked: Option.none() }
		},
		PickedGroup: ({ group }) => closeWith(state, group),
		ChangedDraft: ({ value }) => ({
			state: { ...state, draft: value },
			commands: [],
			picked: Option.none(),
		}),
		SubmittedDraft: () =>
			Str.trim(state.draft) === ""
				? { state, commands: [], picked: Option.none() }
				: closeWith(state, Str.trim(state.draft)),
	})

/** The page's groups, in page order, each once. */
export const groupsOf = (groups: ReadonlyArray<string | null>): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap(groups, (group) => (group === null || Str.trim(group) === "" ? [] : [Str.trim(group)])),
	)

const choice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ label: string; detail: string; isCurrent: boolean; onPick: M }>,
): Html =>
	h.li(
		[h.Key(options.label)],
		[
			pressable(
				h,
				{
					onClick: options.onPick,
					isSelected: options.isCurrent,
					className: cn(
						"flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-surface-sunken active:bg-surface-sunken",
						options.isCurrent && "bg-surface-sunken",
					),
				},
				[
					typography(
						h,
						{ tone: "muted", className: cn("shrink-0", !options.isCurrent && "invisible") },
						[icon(h, "CheckIcon", { size: 14 })],
					),
					typography(h, { size: "sm", weight: "medium", truncate: true }, [options.label]),
					typography(h, { size: "xs", tone: "muted", className: "ml-auto shrink-0" }, [
						options.detail,
					]),
				],
			),
		],
	)

export type GroupDialogViewOptions<M> = Readonly<{
	state: GroupDialog
	/** The groups on the page, with how many components each has. */
	groups: ReadonlyArray<Readonly<{ name: string; count: number }>>
	/** The component's group now, `""` for none. */
	current: string
	/** The component's name, for the title. */
	componentName: string
	toMessage: (message: GroupDialogMessage) => M
}>

export const groupDialogView = <M>(h: HtmlBuilder<M>, options: GroupDialogViewOptions<M>): Html => {
	const { state, toMessage } = options
	const current = Str.trim(options.current)
	const draft = Str.trim(state.draft)
	const isExisting = Arr.some(options.groups, (group) => group.name === draft)
	return formDialog(h, {
		slotId: state.dialog.id,
		model: state.dialog,
		toParentMessage: (message) => toMessage(GroupDialogMessage.GotDialogMessage({ message })),
		title: `Group for ${options.componentName}`,
		description: "Components in one group are listed together under its name on the page.",
		onSubmit: toMessage(GroupDialogMessage.SubmittedDraft()),
		submitLabel: isExisting ? "Move to group" : "Create group",
		isSubmitDisabled: draft === "",
		fields: [
			vstack(h, { gap: "1.5" }, [
				typography(h, { size: "xs", weight: "medium", tone: "muted", as: "p" }, ["On this page"]),
				vstack(h, { gap: "0.5", as: "ul", attributes: [h.AriaLabel("Groups on this page")] }, [
					choice(h, {
						label: "No group",
						detail: "Listed on its own",
						isCurrent: current === "",
						onPick: toMessage(GroupDialogMessage.PickedGroup({ group: "" })),
					}),
					...Arr.map(options.groups, (group) =>
						choice(h, {
							label: group.name,
							detail: group.count === 1 ? "1 component" : `${group.count} components`,
							isCurrent: current === group.name,
							onPick: toMessage(GroupDialogMessage.PickedGroup({ group: group.name })),
						}),
					),
				]),
			]),
			textField(h, {
				id: `${state.dialog.id}-new`,
				label: "New group",
				value: state.draft,
				placeholder: "API, Website, Payments",
				hint: options.groups.length === 0 ? "This page has no groups yet." : undefined,
				onInput: (value) => toMessage(GroupDialogMessage.ChangedDraft({ value })),
			}),
		],
	})
}
