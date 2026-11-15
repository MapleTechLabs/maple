import { SAVED_VIEW_NAME_MAX_LENGTH } from "@maple/domain/saved-views"
import { button } from "@maple/views/ui/button"
import * as Checkbox from "@maple/views/ui/checkbox"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { fieldErrorText } from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import { input } from "@maple/views/ui/input"
import { label } from "@maple/views/ui/label"
import * as MenuView from "@maple/views/ui/menu-view"
import { vstack } from "@maple/views/ui/stack"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { Array as Arr, String as Str } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type ActiveView, activeViewOf, Message, type Model, type SavedView } from "./model"
import { lastBy } from "../last-by"
import type { Explorer } from "./state"
import { ITEM, viewItem } from "./update"

// The Views control as drawn: the toolbar button, its menu, and the save, rename and delete dialogs.

type H = HtmlBuilder<Message>
type Entry = MenuView.MenuEntry

/** The page's view, worked out by the page: a view input is plain data, and matching needs the route. */
export type ViewInputs = Readonly<{ active: ActiveView | null }>

const SEPARATOR: Entry = { _tag: "Separator" }

/** Someone the member directory no longer names, or could not name right now. */
const UNKNOWN_OWNER = "Member"

const viewEntry =
	(active: ActiveView | null) =>
	(view: SavedView): Entry => ({
		_tag: "Item",
		value: viewItem(view.id),
		label: view.name,
		...(view.isOwner ? undefined : { meta: view.ownerName ?? UNKNOWN_OWNER }),
		...(active !== null && active.view.id === view.id ? { isCurrent: true } : undefined),
	})

const group = (
	title: string,
	views: ReadonlyArray<SavedView>,
	active: ActiveView | null,
): ReadonlyArray<Entry> =>
	views.length === 0 ? [] : [{ _tag: "Group", label: title, entries: Arr.map(views, viewEntry(active)) }]

/** What the page's params can become: a new view, or the opened one brought up to date. */
const saveEntries = (active: ActiveView | null, isWriting: boolean): ReadonlyArray<Entry> => {
	if (active === null) return [{ _tag: "Item", value: ITEM.save, label: "Save view…" }]
	if (!active.isModified) return []
	const update: ReadonlyArray<Entry> = active.view.isOwner
		? [{ _tag: "Item", value: ITEM.update, label: "Update view", isDisabled: isWriting }]
		: []
	return [
		...update,
		{ _tag: "Item", value: ITEM.saveAsNew, label: "Save as new…" },
		{ _tag: "Item", value: ITEM.discard, label: "Discard changes" },
	]
}

/** The opened view's own actions: the owner's, and delete for an admin on a shared one. */
const manageEntries = (active: ActiveView | null): ReadonlyArray<Entry> => {
	if (active === null) return []
	const { view } = active
	const owned: ReadonlyArray<Entry> = view.isOwner
		? [
				{ _tag: "Item", value: ITEM.rename, label: "Rename…" },
				{
					_tag: "Checkbox",
					value: ITEM.share,
					label: "Share with organization",
					isChecked: view.visibility === "org",
				},
			]
		: []
	const removal: ReadonlyArray<Entry> = view.canDelete
		? [{ _tag: "Item", value: ITEM.delete, label: "Delete…", variant: "destructive" }]
		: []
	return [...owned, ...removal]
}

const note = (h: H, text: string): Entry => ({
	_tag: "Content",
	content: typography(h, { size: "xs", tone: "muted", as: "p", className: "max-w-64 px-2 py-2" }, [text]),
})

/** The non-empty parts, a separator between each. */
const sections = (parts: ReadonlyArray<ReadonlyArray<Entry>>): ReadonlyArray<Entry> => {
	const present = Arr.filter(parts, (part) => part.length > 0)
	return Arr.flatMap(present, (part, index): ReadonlyArray<Entry> =>
		index === 0 ? part : [SEPARATOR, ...part],
	)
}

const entriesOf = (h: H, model: Model, active: ActiveView | null): ReadonlyArray<Entry> => {
	if (model.views === null) {
		return model.loadFailure === null
			? [note(h, "Loading views…")]
			: [note(h, "Couldn't load views"), { _tag: "Item", value: ITEM.retry, label: "Try again" }]
	}
	const own = Arr.filter(model.views, (view) => view.isOwner)
	const shared = Arr.filter(model.views, (view) => !view.isOwner)
	return sections([
		model.views.length === 0
			? [note(h, "A view keeps this page's filters and time range under a name.")]
			: [...group("Your views", own, active), ...group("Shared", shared, active)],
		saveEntries(active, model.isWriting),
		manageEntries(active),
	])
}

/** The toolbar button: "Views", or the page's view by name, marked once its params were edited. */
const trigger = (h: H, model: Model, active: ActiveView | null): Html =>
	h.submodel({
		slotId: model.menu.id,
		model: model.menu,
		view: MenuView.view,
		toParentMessage: (message) => Message.GotMenuMessage({ message }),
		viewInputs: {
			entries: entriesOf(h, model, active),
			align: "end",
			className: "w-auto min-w-56 max-w-80",
			toView: ({ trigger: attributes, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: active === null ? "outline" : "secondary",
								size: "sm",
								className: "gap-2",
								attributes: [...attributes],
							},
							[
								icon(h, "BookmarkIcon", {
									className: active === null ? "text-muted-foreground" : "text-primary",
								}),
								typography(h, { truncate: true, className: "max-w-40" }, [
									active === null ? "Views" : active.view.name,
								]),
								...(active !== null && active.isModified
									? [typography(h, { tone: "muted" }, ["Edited"])]
									: []),
								icon(h, "ChevronDownIcon", { className: "size-3.5" }),
							],
						),
					),
				),
		},
	})

const nameField = (h: H, model: Model): Html => {
	const id = `${model.formDialog.id}-name`
	const { error } = model.form
	return vstack(h, { gap: "1.5" }, [
		label(h, { className: typographyClass({ size: "xs", tone: "muted" }), attributes: [h.For(id)] }, [
			"Name",
		]),
		input(h, {
			id,
			isDisabled: model.form.isPending,
			attributes: [
				...(error === null ? [] : [h.AriaInvalid(true)]),
				h.Value(model.form.name),
				h.Placeholder("Checkout errors"),
				h.Attribute("maxlength", String(SAVED_VIEW_NAME_MAX_LENGTH)),
				h.Attribute("autocomplete", "off"),
				h.OnInput((value) => Message.ChangedName({ value })),
			],
		}),
		...(error === null ? [] : [fieldErrorText(h, { attributes: [h.Role("alert")] }, error)]),
	])
}

const shareField = (h: H, model: Model): Html => {
	const inputId = `${model.formDialog.id}-share`
	return vstack(h, { gap: "1" }, [
		label(h, { className: "text-sm font-normal", attributes: [h.Id(Checkbox.labelId(inputId))] }, [
			...Checkbox.view(h, {
				model: { isChecked: model.form.isShared },
				toParentMessage: () => Message.ToggledShared(),
				id: `${inputId}-root`,
				inputId,
				isDisabled: model.form.isPending,
			}),
			"Share with organization",
		]),
		typography(h, { size: "xs", tone: "muted", as: "p", className: "pl-6" }, [
			"Everyone in the organization can open it. Only you can change it.",
		]),
	])
}

const formView = (h: H, model: Model): Html => {
	const isSave = model.form.mode === "save"
	return formDialog(h, {
		slotId: `${model.formDialog.id}-dialog`,
		model: model.formDialog,
		toParentMessage: (message) => Message.GotFormDialogMessage({ message }),
		title: isSave ? "Save view" : "Rename view",
		description: isSave ? "Keeps this page's filters and time range under a name." : undefined,
		className: "sm:max-w-md",
		panelClassName: "space-y-4",
		onSubmit: Message.SubmittedForm(),
		submitLabel: isSave ? "Save view" : "Rename view",
		isPending: model.form.isPending,
		isSubmitDisabled: Str.trim(model.form.name) === "",
		fields: [nameField(h, model), ...(isSave ? [shareField(h, model)] : [])],
	})
}

const deleteView = (h: H, model: Model): Html => {
	const target = model.deleteTarget
	return confirmDialog(h, {
		slotId: `${model.deleteDialog.id}-dialog`,
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: target === null ? "Delete view?" : `Delete "${target.name}"?`,
		description:
			target !== null && target.visibility === "org"
				? "It is shared, so it goes away for everyone in the organization."
				: "This can't be undone.",
		confirmLabel: "Delete view",
		onConfirm: Message.ConfirmedDelete(),
		isPending: model.isDeleting,
		...(model.deleteError === null
			? undefined
			: { children: [fieldErrorText(h, { attributes: [h.Role("alert")] }, model.deleteError)] }),
	})
}

/** The Views button with its menu, and the dialogs it opens. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { active }, h) =>
	h.div([h.Class("contents")], [trigger(h, model, active), formView(h, model), deleteView(h, model)]),
)

// Keyed on what the match reads, so an unrelated page render hands the control the same input.
const activeOf = lastBy(
	([views, activeViewId, explorer]: readonly [Model["views"], Model["activeViewId"], Explorer]) =>
		activeViewOf({ views, activeViewId }, explorer),
)

/** The control in a page's toolbar: the Views button, marked with the view the page's URL is. */
export const control = <PageMessage>(
	h: HtmlBuilder<PageMessage>,
	options: Readonly<{
		slotId: string
		model: Model
		explorer: Explorer
		toMessage: (message: Message) => PageMessage
	}>,
): Html =>
	h.submodel({
		slotId: options.slotId,
		model: options.model,
		view,
		viewInputs: {
			active: activeOf([options.model.views, options.model.activeViewId, options.explorer]),
		},
		toParentMessage: options.toMessage,
	})
