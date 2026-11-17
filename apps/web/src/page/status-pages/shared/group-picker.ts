import { Array as Arr, Option, String as Str } from "effect"
import { Command as FoldkitCommand } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "@maple/views/ui/combobox"
import { comboboxPicker, triggerIdOf } from "@maple/views/ui/combobox-picker"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { buttonField, labelledField } from "./fields"

// A component's Group as a dropdown: pick one of the page's groups (or none), or type a new name
// and click Create. The builder and Settings > Monitors share it.

/** The list's values: none, a group of the page, or a group typed to create. */
const NONE = "none"
const groupItem = (name: string) => `group:${name}`
const createItem = (name: string) => `create:${name}`

/** The value of each kind of item, for a click sent without the list (tests, the lab). */
export const groupPickerValue = { none: NONE, group: groupItem, create: createItem } as const

export const initGroupPicker = (id: string): Combobox.Model => Combobox.init(id, "single")

/** The group an item stands for, `""` for none. */
const groupOfItem = (value: string): string =>
	Str.startsWith("group:")(value)
		? Str.slice("group:".length)(value)
		: Str.startsWith("create:")(value)
			? Str.slice("create:".length)(value)
			: ""

/** The page's groups, in page order, each once. */
export const groupsOf = (groups: ReadonlyArray<string | null>): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap(groups, (group) => (group === null || Str.trim(group) === "" ? [] : [Str.trim(group)])),
	)

/** The list for what is typed: matching groups, "No group" while nothing is typed, and Create for a new name. */
export const groupPickerItems = (
	picker: Combobox.Model,
	groups: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const typed = Str.trim(Combobox.queryOf(picker))
	const needle = Str.toLowerCase(typed)
	const matching = Arr.filter(groups, (group) => Str.includes(needle)(Str.toLowerCase(group)))
	const isNew = typed !== "" && !Arr.some(groups, (group) => Str.toLowerCase(group) === needle)
	return [
		...(typed === "" ? [NONE] : []),
		...Arr.map(matching, groupItem),
		...(isNew ? [createItem(typed)] : []),
	]
}

export type GroupPickerStep = Readonly<{
	picker: Combobox.Model
	commands: ReadonlyArray<FoldkitCommand.Command<Combobox.Message>>
	/** The group picked or created, `""` for none. */
	picked: Option.Option<string>
}>

export const updateGroupPicker = (picker: Combobox.Model, message: Combobox.Message): GroupPickerStep => {
	const step = Combobox.update(picker, message)
	// The field shows the component's group, not the item picked: a pick or a close leaves no search
	// typed (a single combobox would keep the item's value, `create:Test`, as its input).
	const isSettled = step.outMessage?._tag === "ChangedValue" || !step.model.isOpen
	return {
		picker: isSettled ? { ...step.model, inputValue: "", selected: [] } : step.model,
		commands: step.commands ?? [],
		picked:
			step.outMessage?._tag === "ChangedValue"
				? Option.some(groupOfItem(step.outMessage.value))
				: Option.none(),
	}
}

export type GroupPickerViewOptions<M> = Readonly<{
	picker: Combobox.Model
	/** The page's groups, in page order. */
	groups: ReadonlyArray<string>
	/** The component's group now, `""` for none. */
	current: string
	isDisabled: boolean
	toMessage: (message: Combobox.Message) => M
}>

const renderItem = (h: HtmlBuilder<Combobox.Message>, value: string): ReadonlyArray<Html | string> =>
	value === NONE
		? [typography(h, { tone: "muted" }, ["No group"])]
		: Str.startsWith("create:")(value)
			? [
					hstack(h, { gap: "1.5", align: "center" }, [
						icon(h, "PlusIcon", { size: 12 }),
						`Create "${groupOfItem(value)}"`,
					]),
				]
			: [groupOfItem(value)]

/** The Group field: a dropdown of the page's groups that also creates one. */
export const groupPickerField = <M>(h: HtmlBuilder<M>, options: GroupPickerViewOptions<M>): Html => {
	const current = Str.trim(options.current)
	const id = options.picker.id
	if (options.isDisabled)
		return buttonField(h, {
			id: triggerIdOf(id),
			label: "Group",
			value: current,
			placeholder: "No group",
			isDisabled: true,
			onClick: options.toMessage(Combobox.Message.ClickedTrigger()),
		})
	const picker = { ...options.picker, selected: [current === "" ? NONE : groupItem(current)] }
	return labelledField(
		h,
		{ id: triggerIdOf(id), label: "Group" },
		h.submodel({
			slotId: `${id}-slot`,
			model: picker,
			view: comboboxPicker,
			toParentMessage: options.toMessage,
			viewInputs: {
				// A group just created, not saved yet, is listed (and ticked) too.
				items: groupPickerItems(picker, groupsOf([...options.groups, current])),
				ariaLabel: current === "" ? "Group" : `Group: ${current}`,
				searchPlaceholder: "Find or create a group…",
				emptyText: "Type a name to create a group",
				trigger: [current === "" ? "No group" : current],
				isPlaceholder: current === "",
				triggerClassName: "w-full",
				popupWidth: "trigger",
				renderItem,
				toView: (parts) => h.div([h.Class("min-w-0")], parts),
			},
		}),
	)
}
