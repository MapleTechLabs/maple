import { PrReviewRepositoryConfig } from "@maple/domain/http"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { field, fieldDescription, fieldLabel } from "../../../ui/field"
import { inlineCode } from "../../../ui/inline-code"
import type * as Select from "../../../ui/select"
import { type SelectEntry, view as selectView } from "../../../ui/select-view"
import { settingRow } from "../../../ui/setting-row"
import * as Switch from "../../../ui/switch"
import { Message, type Model, type SelectField, type SwitchField } from "./form"
import {
	AUTOMATIC_LIMIT_MAX,
	BUILT_IN,
	DAILY_LIMIT_MAX,
	FEEDBACK_LABELS,
	INHERIT,
	INSTRUCTIONS_MAX,
	SEVERITY_LABELS,
	sameState,
	validate,
} from "./state"
import { idsOf, lenses, numberField, textareaField, valueState } from "./view-fields"
import { RULES_COPY } from "./copy"

// `ReviewRulesForm`'s layout, selects, toggles and footer.

type H = HtmlBuilder<Message>

export type ViewInputs = Readonly<{ isAdmin: boolean }>

const entries = (items: ReadonlyArray<readonly [string, string]>): ReadonlyArray<SelectEntry> =>
	items.map(([value, label]) => ({ _tag: "Item", item: { value, label } }))

const selectField = (
	h: H,
	model: Model,
	options: Readonly<{
		name: SelectField
		slug: string
		label: string
		items: ReadonlyArray<readonly [string, string]>
		className: string
		description?: string
	}>,
): Html => {
	const ids = idsOf(model, options.slug)
	const state = valueState(true)
	const select = model.selects[options.name]
	return field(h, { className: "items-stretch", state }, [
		fieldLabel(h, { ids, state }, options.label),
		...(select === undefined
			? []
			: [
					h.submodel({
						slotId: select.id,
						model: select,
						view: selectView,
						toParentMessage: (message: Select.Message) =>
							Message.GotSelectMessage({ field: options.name, message }),
						viewInputs: {
							entries: entries(options.items),
							className: options.className,
							labelledBy: ids.label,
							describedBy: options.description === undefined ? undefined : ids.description,
							toView: (parts) => h.div([h.Class("contents")], parts),
						},
					}),
				]),
		...(options.description === undefined
			? []
			: [fieldDescription(h, { ids, state }, options.description)]),
	])
}

const switchRow = (
	h: H,
	model: Model,
	options: Readonly<{ name: SwitchField; slug: string; label: string; description: string }>,
): Html => {
	const ids = {
		control: `${model.id}-${options.slug}`,
		label: `${model.id}-${options.slug}-label`,
		description: `${model.id}-${options.slug}-description`,
	}
	const isChecked = model.state[options.name] === "on"
	return settingRow(h, {
		ids,
		label: options.label,
		description: options.description,
		filled: isChecked,
		control: Switch.switchControl(h, {
			id: `${ids.control}-switch`,
			inputId: ids.control,
			isChecked,
			isDisabled: model.isSaving,
			labelledBy: ids.label,
			describedBy: ids.description,
			isFilled: isChecked,
			onToggle: Message.ToggledSwitch({ field: options.name }),
		}),
	})
}

const parentOf = (model: Model) => model.inherited ?? new PrReviewRepositoryConfig({})

/** `ToggleSetting`: a switch for the organization, a select that can inherit for a repository. */
const toggleSetting = (
	h: H,
	model: Model,
	options: Readonly<{
		name: SwitchField
		slug: string
		label: string
		description: string
		inherited: boolean
	}>,
): Html =>
	model.mode === "organization"
		? switchRow(h, model, options)
		: selectField(h, model, {
				name: options.name,
				slug: options.slug,
				label: options.label,
				className: "w-full sm:w-1/2",
				description: options.description,
				items: [
					[INHERIT, `Organization default (${options.inherited ? "On" : "Off"})`],
					["on", "On"],
					["off", "Off"],
				],
			})

const limitPlaceholder = (model: Model, value: number | undefined) =>
	model.mode === "repository" ? `Organization default (${value ?? "no limit"})` : "No limit"

const footer = (h: H, model: Model, isAdmin: boolean): ReadonlyArray<Html> => {
	const problem = validate(model.state)
	const isDirty = !sameState(model.state, model.saved)
	return [
		...(model.error !== null
			? [h.p([h.Class("text-xs text-severity-error"), h.Role("alert")], [model.error])]
			: problem !== null && isDirty
				? [h.p([h.Class("text-xs text-muted-foreground")], [problem])]
				: []),
		h.div(
			[h.Class("flex items-center justify-end gap-3 border-t pt-4")],
			[
				...(isAdmin
					? []
					: [
							h.p(
								[h.Class("mr-auto text-xs text-muted-foreground")],
								["Only organization admins can change these settings."],
							),
						]),
				button(
					h,
					{
						variant: "outline",
						isDisabled: !isDirty || model.isSaving,
						attributes: [h.OnClick(Message.ClickedReset())],
					},
					["Reset"],
				),
				button(
					h,
					{
						isLoading: model.isSaving,
						isDisabled: !isAdmin || !isDirty || problem !== null,
						attributes: [h.OnClick(Message.ClickedSave())],
					},
					["Save"],
				),
			],
		),
	]
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const isRepository = model.mode === "repository"
	const parent = parentOf(model)
	const inheritedSeverity = SEVERITY_LABELS[parent.minInlineSeverity ?? BUILT_IN.minInlineSeverity]
	const inheritedFeedback = FEEDBACK_LABELS[parent.feedbackScope ?? BUILT_IN.feedbackScope]
	const inheritedDrafts = (parent.reviewDrafts ?? BUILT_IN.reviewDrafts) ? "Review drafts" : "Skip drafts"
	const inheritOption = (label: string): ReadonlyArray<readonly [string, string]> =>
		isRepository ? [[INHERIT, `Organization default (${label})`]] : []
	return h.fieldset(
		[
			h.Class("m-0 flex min-w-0 flex-col gap-6 border-0 p-0"),
			...(model.isSaving ? [h.Disabled(true)] : []),
		],
		[
			textareaField(h, model, {
				name: "instructions",
				slug: "instructions",
				label: isRepository ? "Additional instructions" : "Instructions",
				placeholder: isRepository
					? "Rules for this repository, read after the organization's."
					: 'Rules every review applies on top of its defaults, e.g. "Flag any new endpoint without an auth check."',
				controlClassName: "min-h-24 max-h-64",
				maxLength: INSTRUCTIONS_MAX,
				description: [
					RULES_COPY.instructionsHint,
					" ",
					String(model.state.instructions.length),
					"/",
					String(INSTRUCTIONS_MAX),
				],
			}),
			textareaField(h, model, {
				name: "ignorePaths",
				slug: "ignore",
				label: isRepository ? "Additional ignored paths" : "Ignored paths",
				placeholder: "generated/\n*.pb.go\napps/**/routeTree.gen.ts",
				controlClassName: "max-h-40 font-mono",
				description: [
					RULES_COPY.ignoreHint,
					...(isRepository && parent.ignorePaths && parent.ignorePaths.length > 0
						? [` The organization already ignores ${parent.ignorePaths.length}.`]
						: []),
				],
			}),
			lenses(h, model),
			h.div(
				[h.Class("grid gap-6 sm:grid-cols-2")],
				[
					selectField(h, model, {
						name: "minInlineSeverity",
						slug: "severity",
						label: RULES_COPY.severity.label,
						className: "w-full",
						items: [...inheritOption(inheritedSeverity), ...Object.entries(SEVERITY_LABELS)],
						description: RULES_COPY.severity.description,
					}),
					selectField(h, model, {
						name: "feedbackScope",
						slug: "feedback",
						label: RULES_COPY.feedback.label,
						className: "w-full",
						items: [...inheritOption(inheritedFeedback), ...Object.entries(FEEDBACK_LABELS)],
						description: RULES_COPY.feedback.description,
					}),
					numberField(h, model, {
						name: "dailyLimit",
						slug: "limit",
						label: RULES_COPY.limit.label,
						max: DAILY_LIMIT_MAX,
						placeholder: limitPlaceholder(model, parent.dailyLimit),
						description: [RULES_COPY.limit.description],
					}),
					numberField(h, model, {
						name: "automaticReviewLimit",
						slug: "per-pr",
						label: RULES_COPY.perPr.label,
						max: AUTOMATIC_LIMIT_MAX,
						placeholder: limitPlaceholder(model, parent.automaticReviewLimit),
						description: [
							RULES_COPY.perPr.description[0],
							" ",
							inlineCode(h, {}, ["review"]),
							" ",
							RULES_COPY.perPr.description[1],
						],
					}),
				],
			),
			isRepository
				? selectField(h, model, {
						name: "reviewDrafts",
						slug: "drafts",
						label: "Draft pull requests",
						className: "w-full sm:w-1/2",
						items: [
							[INHERIT, `Organization default (${inheritedDrafts})`],
							["on", "Review drafts"],
							["off", "Skip drafts"],
						],
					})
				: switchRow(h, model, {
						name: "reviewDrafts",
						slug: "drafts",
						label: RULES_COPY.drafts.label,
						description: RULES_COPY.drafts.description,
					}),
			toggleSetting(h, model, {
				name: "reviewExternalContributors",
				slug: "external",
				label: RULES_COPY.external.label,
				description: RULES_COPY.external.description,
				inherited: parent.reviewExternalContributors ?? BUILT_IN.reviewExternalContributors,
			}),
			toggleSetting(h, model, {
				name: "blockOnContractBreaks",
				slug: "block-breaks",
				label: RULES_COPY.blockBreaks.label,
				description: RULES_COPY.blockBreaks.description,
				inherited: parent.blockOnContractBreaks ?? BUILT_IN.blockOnContractBreaks,
			}),
			toggleSetting(h, model, {
				name: "postMergeCheck",
				slug: "post-merge",
				label: RULES_COPY.postMerge.label,
				description: RULES_COPY.postMerge.description,
				inherited: parent.postMergeCheck ?? BUILT_IN.postMergeCheck,
			}),
			...footer(h, model, inputs.isAdmin),
		],
	)
})
