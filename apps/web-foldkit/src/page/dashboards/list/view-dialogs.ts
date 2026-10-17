import { cn } from "@maple/ui/lib/utils"
import * as AlertDialogStyles from "@maple/ui/styles/ui/alert-dialog"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import {
	confirmDialogIconDestructiveStyles,
	confirmDialogMediaDestructiveStyles,
} from "@maple/ui/styles/ui/confirm-dialog"
import * as DialogStyles from "@maple/ui/styles/ui/dialog"
import { formDialogFormStyles, formDialogPanelStyles } from "@maple/ui/styles/ui/form-dialog"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { descriptionId, titleId } from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { dialogFooter, dialogHeader, dialogPanel } from "../../../ui/dialog-view"
import { field, fieldDescription, fieldLabel, type FieldState } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"
import { displayName, normalizeTags, splitTagInput } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The list's `ConfirmDialog` (delete) and `TagEditorDialog` (dashboard-builder/tag-editor.tsx).

type H = HtmlBuilder<Message>

const IDLE: FieldState = {
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
	isInvalid: false,
}

/** `ConfirmDialog` with the warning media, "Delete “name”?" and the destructive confirm. */
export const deleteDialog = (h: H, model: Model): Html => {
	const id = model.deleteDialog.id
	const name = displayName(model.pendingDelete?.name)
	return h.submodel({
		slotId: id,
		model: model.deleteDialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				dialogHeader(h, "alert-dialog", [
					h.div(
						[
							h.Class(
								cn(
									AlertDialogStyles.alertDialogMediaStyles,
									confirmDialogMediaDestructiveStyles,
								),
							),
							h.DataAttribute("slot", "alert-dialog-media"),
						],
						[icon(h, "CircleWarningIcon", { className: confirmDialogIconDestructiveStyles })],
					),
					h.h2(
						[
							h.Class(cn(AlertDialogStyles.alertDialogTitleStyles)),
							h.DataAttribute("slot", "alert-dialog-title"),
							h.Id(titleId(id)),
						],
						["Delete “", name, "”?"],
					),
					h.p(
						[
							h.Class(cn(AlertDialogStyles.alertDialogDescriptionStyles)),
							h.DataAttribute("slot", "alert-dialog-description"),
							h.Id(descriptionId(id)),
						],
						[
							"This dashboard belongs to the whole org: deleting it removes it for everyone, not just you. It can’t be undone. Export the JSON first if you might want it back.",
						],
					),
				]),
				dialogFooter(h, "alert-dialog", [
					button(h, { variant: "outline", slot: "alert-dialog-cancel", attributes: close }, [
						"Cancel",
					]),
					button(
						h,
						{ variant: "destructive", attributes: [h.OnClick(Message.ClickedConfirmDelete())] },
						["Delete for everyone"],
					),
				]),
			],
		},
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
	})
}

const TAG_INPUT_ID = "tag-editor-input"
const TAG_IDS = { control: TAG_INPUT_ID, label: `${TAG_INPUT_ID}-label`, error: `${TAG_INPUT_ID}-error` }

const draftChips = (h: H, model: Model): Html =>
	model.tagDrafts.length === 0
		? fieldDescription(
				h,
				{ ids: TAG_IDS, className: "text-2xs", state: IDLE },
				"No tags yet, so this dashboard won't appear under any Tags filter.",
			)
		: h.div(
				[h.Class("flex flex-wrap gap-1")],
				model.tagDrafts.map((tag) =>
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
									className: "size-4 text-muted-foreground hover:text-foreground",
									attributes: [h.OnClick(Message.ClickedRemoveTag({ tag }))],
								},
								[icon(h, "XmarkIcon")],
							),
						],
					),
				),
			)

/** `TagEditorDialog` on `FormDialog`: add, remove, suggestions, Save. */
export const tagsDialog = (h: H, model: Model, allTags: ReadonlyArray<string>): Html => {
	const id = model.tagsDialog.id
	const name = displayName(model.pendingTags?.name)
	const unused = normalizeTags(allTags).filter((tag) => !model.tagDrafts.includes(tag))
	const canAdd = normalizeTags(splitTagInput(model.tagInput)).length > 0
	return h.submodel({
		slotId: id,
		model: model.tagsDialog,
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
									h.span([h.Class("text-foreground")], [name]),
									" with related dashboards. Tags drive the Tags filter on the dashboards list.",
								],
							),
						]),
						dialogPanel(
							h,
							"dialog",
							id,
							[
								field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
									fieldLabel(
										h,
										{ ids: TAG_IDS, className: "text-xs", state: IDLE },
										"Add a tag",
									),
									h.div(
										[h.Class("flex items-center gap-1.5")],
										[
											input(h, {
												id: TAG_INPUT_ID,
												size: "sm",
												attributes: [
													h.Value(model.tagInput),
													h.Placeholder("slo, api, team-platform"),
													h.Maxlength(32),
													h.OnInput((value) => Message.ChangedTagInput({ value })),
													h.OnKeyDownPreventDefault((key) =>
														key === "Enter" ||
														key === "," ||
														(key === "Backspace" && model.tagInput === "")
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
								]),
								field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
									h.label(
										[h.DataAttribute("slot", "field-label"), h.Class("text-xs")],
										["On this dashboard"],
									),
									draftChips(h, model),
								]),
								...(unused.length === 0
									? []
									: [
											field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
												h.label(
													[
														h.DataAttribute("slot", "field-label"),
														h.Class("text-xs"),
													],
													["Used elsewhere"],
												),
												h.div(
													[h.Class("flex flex-wrap gap-1")],
													unused.map((tag) =>
														button(
															h,
															{
																variant: "outline",
																size: "xs",
																className: "font-mono text-2xs",
																attributes: [
																	h.OnClick(
																		Message.ClickedSuggestedTag({ tag }),
																	),
																],
															},
															[
																icon(h, "PlusIcon", {
																	attributes: [
																		h.DataAttribute(
																			"icon",
																			"inline-start",
																		),
																	],
																}),
																tag,
															],
														),
													),
												),
											]),
										]),
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
		toParentMessage: (message) => Message.GotTagsDialogMessage({ message }),
	})
}
