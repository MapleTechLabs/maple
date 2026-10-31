import { TONE_TEXT } from "@maple/ui/lib/tone"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { formDialog } from "../../../../ui/form-dialog"
import { icon, type IconName } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import { inlineCode } from "../../../../ui/inline-code"
import { item, itemActions, itemContent, itemDescription, itemTitle } from "../../../../ui/item"
import { draftError, sourceSummary, TYPE_LABELS } from "./derive"
import { Message, type Model, type Variable } from "./model"
import { hasErrors } from "./update"
import { variableForm } from "./view-form"

type H = HtmlBuilder<Message>

const intro = (h: H): Html =>
	h.div(
		[
			h.Class(
				"rounded-md border border-dashed border-border px-3 py-3 text-2xs leading-relaxed text-muted-foreground",
			),
		],
		[
			h.p(
				[],
				[
					"A variable adds a selector to the toolbar; widgets that reference it re-query when the selection changes.",
				],
			),
			h.ul(
				[h.Class("mt-1.5 flex flex-col gap-0.5")],
				[
					h.li(
						[],
						[
							h.span([h.Class("text-foreground")], ["Query"]),
							": values from your telemetry (services, environments, attribute values).",
						],
					),
					h.li(
						[],
						[h.span([h.Class("text-foreground")], ["Custom"]), ": a fixed list you define."],
					),
					h.li(
						[],
						[
							h.span([h.Class("text-foreground")], ["Textbox"]),
							": free text, e.g. a search needle.",
						],
					),
				],
			),
		],
	)

const action = (h: H, label: string, iconName: IconName, onClick: Message, isDisabled = false): Html =>
	iconButton(
		h,
		{ label, size: "icon-xs", isDisabled, attributes: isDisabled ? [] : [h.OnClick(onClick)] },
		[icon(h, iconName)],
	)

const row = (h: H, model: Model, draft: Variable, index: number): Html => {
	const error = draftError(draft, index, model.drafts)
	const isEditing = model.editingIndex === index
	return h.div(
		[h.Class("rounded-md border border-border")],
		[
			item(h, { size: "xs", variant: "flush", className: "px-3" }, [
				itemContent(h, [
					itemTitle(
						h,
						[
							"$",
							draft.name === "" ? "…" : draft.name,
							h.span(
								[h.Class("ml-2 font-sans font-normal text-muted-foreground")],
								[TYPE_LABELS[draft.type]],
							),
						],
						"block truncate font-mono text-foreground",
					),
					itemDescription(
						h,
						[
							error !== null && !isEditing
								? h.span([h.Class(TONE_TEXT.crit)], [error])
								: sourceSummary(draft),
						],
						"block truncate text-2xs",
					),
				]),
				itemActions(h, [
					action(
						h,
						"Move up",
						"ArrowUpIcon",
						Message.ClickedMove({ index, delta: -1 }),
						index === 0,
					),
					action(
						h,
						"Move down",
						"ArrowDownIcon",
						Message.ClickedMove({ index, delta: 1 }),
						index === model.drafts.length - 1,
					),
					action(h, "Edit variable", "PencilIcon", Message.ClickedEdit({ index })),
					action(h, "Delete variable", "TrashIcon", Message.ClickedDelete({ index })),
				]),
			]),
			...(isEditing
				? [
						h.div(
							[h.Class("border-t border-border px-3 py-3")],
							[variableForm(h, model, draft, error)],
						),
					]
				: []),
		],
	)
}

export const view = Submodel.defineView<Model, Message, Readonly<{ slotId: string }>>((model, inputs, h) =>
	formDialog(h, {
		slotId: inputs.slotId,
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		className: "sm:max-w-xl",
		panelClassName: "flex flex-col gap-3 space-y-0",
		title: "Dashboard variables",
		description: [
			"Reference variables as ",
			inlineCode(h, {}, ["$name"]),
			" in widget filters and raw SQL. Selectors appear in the dashboard toolbar.",
		],
		submitLabel: "Save variables",
		isSubmitDisabled: hasErrors(model),
		onSubmit: Message.SubmittedForm(),
		fields: [
			...(model.startedEmpty ? [intro(h)] : []),
			...model.drafts.map((draft, index) => row(h, model, draft, index)),
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					className: "self-start",
					attributes: [h.OnClick(Message.ClickedAdd())],
				},
				[
					icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
					"Add variable",
				],
			),
		],
	}),
)
