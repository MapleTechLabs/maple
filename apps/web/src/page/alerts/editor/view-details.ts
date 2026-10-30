import { cn } from "@maple/ui/lib/utils"
import { Option, Struct } from "effect"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { button } from "../../../ui/button"
import { card } from "../../../ui/card"
import { field, fieldDescription, fieldLabel, input } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { textarea } from "../../../ui/textarea"
import { stableSlice } from "../../kit/stable-slice"
import { suggestedName } from "./derive"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { fieldStateOf, idsOf } from "./view-fields"

// `DetailsSection` and `TagInput`: the rule's name, description and tags.

type H = HtmlBuilder<Message>

const TAG_LIST_ID = "rule-tags-suggestions"

/** What the section reads off the Model. */
type DetailsView = Pick<Model, "mountedForm" | "tagDraft" | "isNotesOpen" | "tagSuggestions">

/** `TagInput`: chips, a free-text input committing on Enter or comma, and the org's tags as a datalist. */
const tagInput = (h: H, model: DetailsView, form: RuleForm): Html => {
	const available = model.tagSuggestions.filter((tag) => !form.tags.includes(tag))
	return h.div(
		[
			h.Class(
				cn(
					"flex min-h-8.5 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 text-sm",
					"ring-ring/24 transition-shadow focus-within:border-ring focus-within:ring-[3px] dark:bg-input/32",
				),
			),
		],
		[
			...form.tags.map((tag) =>
				badge(h, { variant: "secondary", size: "sm", className: "gap-1 pr-1" }, [
					tag,
					iconButton(
						h,
						{
							size: "icon-2xs",
							label: `Remove ${tag}`,
							hasTooltip: false,
							className: "-mr-0.5 text-muted-foreground hover:text-foreground",
							attributes: [h.OnClick(Message.ClickedRemoveTag({ tag }))],
						},
						[icon(h, "XmarkIcon")],
					),
				]),
			),
			h.input([
				h.Id("rule-tags"),
				...(available.length > 0 ? [h.Attribute("list", TAG_LIST_ID)] : []),
				h.Value(model.tagDraft),
				h.OnInput((value) => Message.ChangedTagDraft({ value })),
				// Backspace on an empty draft removes the last chip; otherwise it edits the draft.
				h.OnKeyDownPreventDefault((key) =>
					key === "Enter" || key === "," || (key === "Backspace" && model.tagDraft.length === 0)
						? Option.some(Message.PressedTagKey({ key }))
						: Option.none(),
				),
				h.OnBlur(Message.BlurredTagInput()),
				...(form.tags.length === 0 ? [h.Placeholder("prod, payments, team-checkout…")] : []),
				h.Class(
					"min-w-[80px] flex-1 bg-transparent leading-6 outline-none placeholder:text-muted-foreground/70",
				),
			]),
			...(available.length > 0
				? [
						h.datalist(
							[h.Id(TAG_LIST_ID)],
							available.map((tag) => h.option([h.Value(tag)], [])),
						),
					]
				: []),
		],
	)
}

const nameField = (h: H, model: DetailsView, form: RuleForm): Html => {
	const suggestion = suggestedName(form)
	const isSuggesting = form.name.trim().length === 0 && suggestion !== null && suggestion.length > 0
	const state = fieldStateOf(form.name, model.mountedForm?.name)
	const ids = idsOf("rule-name", false)
	return field(h, { className: "items-stretch gap-1.5", state }, [
		h.div(
			[h.Class("flex items-center justify-between gap-2")],
			[
				fieldLabel(h, { ids, state }, "Rule name"),
				...(isSuggesting
					? [
							button(
								h,
								{
									variant: "ghost",
									size: "xs",
									className: "px-1.5 text-2xs",
									attributes: [h.OnClick(Message.ClickedSuggestName())],
								},
								["Suggest: ", suggestion ?? ""],
							),
						]
					: []),
			],
		),
		input(h, {
			ids,
			state,
			attributes: [
				h.Placeholder("Error rate on payments"),
				h.Value(form.name),
				h.OnInput((value) => Message.ChangedField({ field: "name", value })),
			],
		}),
	])
}

const notes = (h: H, model: DetailsView, form: RuleForm): Html => {
	if (!model.isNotesOpen)
		return h.button(
			[
				h.Type("button"),
				h.OnClick(Message.ClickedAddNotes()),
				h.Class(
					"flex w-full items-center gap-1.5 rounded-md border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground hover:border-border hover:text-foreground",
				),
			],
			[icon(h, "PlusIcon", { size: 12 }), "Add notes"],
		)
	const state = fieldStateOf(form.notes, model.mountedForm?.notes)
	const ids = idsOf("rule-notes", false)
	return field(h, { className: "items-stretch gap-1.5", state }, [
		fieldLabel(h, { ids, state }, "Notes"),
		textarea(h, {
			id: "rule-notes",
			defaultValue: form.notes,
			attributes: [
				h.AriaLabelledBy(ids.label),
				h.Placeholder("Runbook links, ownership, or why this rule exists…"),
				h.Rows(2),
				// `autoFocus={!hasExistingNotes}`: opened from the button, the field takes focus.
				...(model.mountedForm?.notes.trim().length === 0 ? [h.Autofocus(true)] : []),
				h.OnInput((value) => Message.ChangedField({ field: "notes", value })),
			],
		}),
	])
}

const details = (h: H, model: DetailsView, form: RuleForm): Html => {
	const tagIds = idsOf("rule-tags", true)
	const tagState = fieldStateOf("", undefined)
	return card(
		h,
		[
			h.div(
				[h.Class("space-y-3")],
				[
					nameField(h, model, form),
					field(h, { className: "items-stretch gap-1.5", state: tagState }, [
						fieldLabel(h, { ids: tagIds, state: tagState }, "Tags"),
						tagInput(h, model, form),
						fieldDescription(
							h,
							{ ids: tagIds, state: tagState },
							"Group and filter rules in the alerts list. Press Enter to add.",
						),
					]),
					notes(h, model, form),
				],
			),
		],
		"p-4",
	)
}

const slot = createLazy()
const viewOf = stableSlice((model: Model) =>
	Struct.pick(model, ["mountedForm", "tagDraft", "isNotesOpen", "tagSuggestions"]),
)

/** `DetailsSection`: the name with a one-click suggestion, tags, and notes behind a button. */
export const detailsSection = (h: H, model: Model, form: RuleForm): Html =>
	slot(details, [h, viewOf(model), form])
