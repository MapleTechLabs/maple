import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import * as DialogStyles from "@maple/ui/styles/ui/dialog"
import { fieldLabelStyles } from "@maple/ui/styles/ui/field"
import { formDialogFormStyles, formDialogPanelStyles } from "@maple/ui/styles/ui/form-dialog"
import { Option, Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { button } from "../../../ui/button"
import * as Dialog from "../../../ui/dialog"
import { descriptionId, titleId } from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { dialogFooter, dialogHeader, dialogPanel } from "../../../ui/dialog-view"
import { field, fieldDescription, fieldLabel, type FieldState } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"

// `TagEditorDialog` on `FormDialog`: one dashboard's tags,
// added by typing or from the org's other tags, removed by chip; Save reports them.

const MAX_TAG_LENGTH = 32

/** `normalizeTags`: trimmed, lower-cased, capped, deduped, sorted. */
export const normalizeTags = (input: ReadonlyArray<string>): ReadonlyArray<string> =>
	Array.from(
		new Set(
			input.map((raw) => raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)).filter((tag) => tag !== ""),
		),
	).sort()

/** `splitInput`: commas and newlines separate tags. */
export const splitTagInput = (value: string): ReadonlyArray<string> => value.split(/[,\n]/)

// MODEL

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	/** The dashboard's name, for the description. */
	name: Schema.String,
	drafts: Schema.Array(Schema.String),
	input: Schema.String,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "dialog"),
	name: "",
	drafts: [],
	input: "",
})

// MESSAGE

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	ChangedTagInput: { value: Schema.String },
	PressedTagInputKey: { key: Schema.String },
	ClickedAddTag: {},
	ClickedRemoveTag: { tag: Schema.String },
	ClickedSuggestedTag: { tag: Schema.String },
	ClickedSaveTags: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ SavedTags: { tags: Schema.Array(Schema.String) } })
export type OutMessage = typeof OutMessage.Type

// UPDATE

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const wrap = (message: Dialog.Message) => Message.GotDialogMessage({ message })

/** Opens on a dashboard's current tags, the input empty. */
export const open = (model: Model, name: string, tags: ReadonlyArray<string>): Return => {
	const next = Dialog.open(model.dialog)
	return {
		model: { ...model, dialog: next.model, name, drafts: normalizeTags(tags), input: "" },
		commands: Command.mapMessages(next.commands ?? [], wrap),
	}
}

const commitInput = (model: Model, value: string): Model => {
	const added = normalizeTags(splitTagInput(value))
	return added.length === 0
		? { ...model, input: "" }
		: { ...model, drafts: normalizeTags([...model.drafts, ...added]), input: "" }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: inner }) => {
			const next = Dialog.update(model.dialog, inner)
			return {
				model: { ...model, dialog: next.model },
				commands: Command.mapMessages(next.commands ?? [], wrap),
			}
		},
		ChangedTagInput: ({ value }) => ({ model: { ...model, input: value } }),
		PressedTagInputKey: ({ key }) => {
			if (key === "Enter" || key === ",") return { model: commitInput(model, model.input) }
			const last = model.drafts[model.drafts.length - 1]
			return key === "Backspace" && model.input === "" && last !== undefined
				? { model: { ...model, drafts: model.drafts.filter((tag) => tag !== last) } }
				: { model }
		},
		ClickedAddTag: () => ({ model: commitInput(model, model.input) }),
		ClickedRemoveTag: ({ tag }) => ({
			model: { ...model, drafts: model.drafts.filter((draft) => draft !== tag) },
		}),
		ClickedSuggestedTag: ({ tag }) => ({ model: commitInput(model, tag) }),
		ClickedSaveTags: () => {
			const tags = normalizeTags([...model.drafts, ...splitTagInput(model.input)])
			const closed = Dialog.close(model.dialog)
			return {
				model: { ...model, dialog: closed.model },
				commands: Command.mapMessages(closed.commands ?? [], wrap),
				outMessage: OutMessage.SavedTags({ tags }),
			}
		},
	})

// VIEW

type H = HtmlBuilder<Message>

const IDLE: FieldState = {
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
	isInvalid: false,
}

/** A `FieldLabel` with no control of its own (a chip list follows it). */
const plainFieldLabel = (h: H, text: string): Html =>
	h.label([h.Class(cn(fieldLabelStyles, "text-xs")), h.DataAttribute("slot", "field-label")], [text])

const TAG_INPUT_ID = "tag-editor-input"
const TAG_IDS = { control: TAG_INPUT_ID, label: `${TAG_INPUT_ID}-label`, error: `${TAG_INPUT_ID}-error` }

const draftChips = (h: H, model: Model): Html =>
	model.drafts.length === 0
		? fieldDescription(
				h,
				{ ids: TAG_IDS, className: "text-2xs", state: IDLE },
				"No tags yet, so this dashboard won't appear under any Tags filter.",
			)
		: h.div(
				[h.Class("flex flex-wrap gap-1")],
				model.drafts.map((tag) =>
					h.span(
						[
							h.Class(
								cn(
									badgeVariants({
										variant: "secondary",
										className: "gap-1 pr-1 font-mono text-2xs",
									}),
								),
							),
							h.DataAttribute("slot", "badge"),
						],
						[
							tag,
							iconButton(
								h,
								{
									size: "icon-xs",
									label: `Remove tag ${tag}`,
									hasTooltip: false,
									className:
										"size-4 text-muted-foreground hover:text-foreground active:text-foreground",
									attributes: [h.OnClick(Message.ClickedRemoveTag({ tag }))],
								},
								[icon(h, "XmarkIcon")],
							),
						],
					),
				),
			)

const suggestions = (h: H, unused: ReadonlyArray<string>): ReadonlyArray<Html> =>
	unused.length === 0
		? []
		: [
				field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
					plainFieldLabel(h, "Used elsewhere"),
					h.div(
						[h.Class("flex flex-wrap gap-1")],
						unused.map((tag) =>
							button(
								h,
								{
									variant: "outline",
									size: "xs",
									className: "font-mono text-2xs",
									attributes: [h.OnClick(Message.ClickedSuggestedTag({ tag }))],
								},
								[
									icon(h, "PlusIcon", {
										attributes: [h.DataAttribute("icon", "inline-start")],
									}),
									tag,
								],
							),
						),
					),
				]),
			]

const tagInput = (h: H, model: Model): Html => {
	const canAdd = normalizeTags(splitTagInput(model.input)).length > 0
	return field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
		fieldLabel(h, { ids: TAG_IDS, className: "text-xs", state: IDLE }, "Add a tag"),
		h.div(
			[h.Class("flex items-center gap-1.5")],
			[
				input(h, {
					id: TAG_INPUT_ID,
					size: "sm",
					attributes: [
						h.Value(model.input),
						h.Placeholder("slo, api, team-platform"),
						h.Maxlength(32),
						h.OnInput((value) => Message.ChangedTagInput({ value })),
						h.OnKeyDownPreventDefault((key) =>
							key === "Enter" || key === "," || (key === "Backspace" && model.input === "")
								? Option.some(Message.PressedTagInputKey({ key }))
								: Option.none(),
						),
						h.OnBlur(Message.ClickedAddTag()),
					],
				}),
				iconButton(
					h,
					{
						variant: "outline",
						label: "Add tag",
						isDisabled: !canAdd,
						attributes: [h.OnClick(Message.ClickedAddTag())],
					},
					[icon(h, "PlusIcon")],
				),
			],
		),
	])
}

export type ViewInputs = Readonly<{
	/** Every tag in the org (`collectTags`); those not on this dashboard are offered. */
	allTags: ReadonlyArray<string>
}>

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const id = model.dialog.id
	const unused = normalizeTags(inputs.allTags).filter((tag) => !model.drafts.includes(tag))
	return h.submodel({
		slotId: id,
		model: model.dialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			className: "sm:max-w-md",
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				h.form(
					[h.Class(formDialogFormStyles), h.OnSubmit(Message.ClickedSaveTags())],
					[
						dialogHeader(h, "dialog", [
							h.h2(
								[
									h.Class(cn(DialogStyles.dialogTitleStyles)),
									h.DataAttribute("slot", "dialog-title"),
									h.Id(titleId(id)),
								],
								["Tags"],
							),
							h.p(
								[
									h.Class(cn(DialogStyles.dialogDescriptionStyles)),
									h.DataAttribute("slot", "dialog-description"),
									h.Id(descriptionId(id)),
								],
								[
									"Group ",
									h.span([h.Class("text-foreground")], [model.name]),
									" with related dashboards. Tags drive the Tags filter on the dashboards list.",
								],
							),
						]),
						dialogPanel(
							h,
							"dialog",
							id,
							[
								tagInput(h, model),
								field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
									plainFieldLabel(h, "On this dashboard"),
									draftChips(h, model),
								]),
								...suggestions(h, unused),
							],
							cn(formDialogPanelStyles, "flex flex-col gap-3 space-y-0"),
						),
						dialogFooter(h, "dialog", [
							button(h, { variant: "outline", attributes: close }, ["Cancel"]),
							button(h, { type: "submit" }, ["Save"]),
						]),
					],
				),
			],
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	})
})
