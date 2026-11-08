import type { DataSourceKind } from "@maple/domain/data-sources"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { field, fieldDescription, fieldError, fieldLabel } from "@maple/views/ui/field"
import { grid } from "@maple/views/ui/grid"
import { icon } from "@maple/views/ui/icon"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { panel } from "@maple/views/ui/panel"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textarea } from "@maple/views/ui/textarea"
import { typography } from "@maple/views/ui/typography"
import { settingsSection } from "../kit/section"
import { switchRow } from "../kit/switch-row"
import { draftErrors } from "./draft"
import { type DraftField, Message, type Model } from "./model"
import { sourceById } from "./state"
import { connectionFields } from "./view-form-connection"
import { describedByOf, ids, stateOf, textField } from "./view-field"
import { ENVIRONMENT_LABEL, KIND_LABEL } from "./view-parts"

type H = HtmlBuilder<Message>

/** The field errors shown: the form's own rules once submitted, then what the API named. */
export const visibleErrors = (model: Model, kind: DataSourceKind, isEditing: boolean) => {
	const local = model.isSubmitted ? draftErrors(model.draft, kind, isEditing) : {}
	const param = model.saveError?.param
	const fromApi: Partial<Record<DraftField, string>> =
		model.saveError !== null && (param === "name" || param === "description" || param === "tags")
			? { [param]: model.saveError.message }
			: {}
	return { ...fromApi, ...local }
}

const descriptionField = (h: H, model: Model, error: string | undefined): Html => {
	const state = stateOf(model.draft.description, error)
	const fieldIds = ids("description")
	return field(h, { state }, [
		fieldLabel(h, { ids: fieldIds, state }, "Description"),
		textarea(h, {
			id: fieldIds.control,
			size: "sm",
			isDisabled: model.isSaving,
			attributes: [
				h.Value(model.draft.description),
				h.Placeholder("Production storefront database: orders, payments and refunds"),
				h.AriaLabelledBy(fieldIds.label),
				h.AriaDescribedBy(describedByOf(fieldIds, error !== undefined)),
				...(error === undefined ? [] : [h.AriaInvalid(true)]),
				h.OnInput((value) => Message.ChangedField({ field: "description", value })),
			],
		}),
		fieldDescription(
			h,
			{ ids: fieldIds, state },
			"Required. Assistants read it to pick the right source, so say what the data is.",
		),
		...(error === undefined ? [] : [fieldError(h, { ids: fieldIds, state }, error)]),
	])
}

const environmentField = (h: H, model: Model): Html => {
	const state = stateOf(model.draft.environment, undefined)
	const fieldIds = ids("environment")
	return field(h, { state }, [
		fieldLabel(h, { ids: fieldIds, state }, "Environment"),
		nativeSelect(
			h,
			{
				defaultValue: model.draft.environment,
				isDisabled: model.isSaving,
				attributes: [
					h.Id(fieldIds.control),
					h.OnChange((value) => Message.ChangedEnvironment({ value })),
				],
			},
			[
				nativeOption("production", ENVIRONMENT_LABEL.production),
				nativeOption("staging", ENVIRONMENT_LABEL.staging),
				nativeOption("development", ENVIRONMENT_LABEL.development),
				nativeOption("other", ENVIRONMENT_LABEL.other),
			],
		),
	])
}

const saveErrorAlert = (h: H, model: Model): ReadonlyArray<Html> => {
	const error = model.saveError
	if (error === null || error.param === "name" || error.param === "description" || error.param === "tags")
		return []
	return [
		alert(h, { variant: "crit" }, [
			icon(h, "CircleWarningIcon"),
			alertTitle(h, [error.param === "connection" ? "Maple could not connect" : error.title]),
			alertDescription(h, [error.message]),
		]),
	]
}

export const formView = (h: H, model: Model, kind: DataSourceKind, editing: string | null): Html => {
	const isEditing = editing !== null
	const errors = visibleErrors(model, kind, isEditing)
	// The saved name, not the draft's: the heading does not follow typing, or go blank with the field.
	const title = isEditing
		? Option.match(sourceById(model, editing), {
				onNone: () => "Edit data source",
				onSome: (source) => `Edit ${source.name}`,
			})
		: `Connect ${KIND_LABEL[kind]}`
	return settingsSection(h, { id: "data-source-form", title, framed: false }, [
		panel(h, { padded: true }, [
			vstack(h, { gap: "5" }, [
				...saveErrorAlert(h, model),
				grid(h, { sm: 2, gap: "3" }, [
					textField(h, {
						name: "name",
						label: "Name",
						value: model.draft.name,
						error: errors.name,
						placeholder: kind === "clickhouse" ? "shop-prod" : "clerk-prod",
						description:
							"The slug tools and assistants use. Lowercase letters, digits and dashes.",
						isDisabled: model.isSaving,
					}),
					environmentField(h, model),
				]),
				descriptionField(h, model, errors.description),
				textField(h, {
					name: "tags",
					label: "Tags",
					value: model.draft.tags,
					error: errors.tags,
					placeholder: "billing, customers",
					description: "Optional, comma separated.",
					isDisabled: model.isSaving,
				}),
				...connectionFields(h, model, kind, isEditing, errors),
				vstack(h, { gap: "4" }, [
					switchRow(h, {
						id: "data-source-agent-access",
						label: "Assistants and agents may query this source",
						description:
							"Off hides it from the MCP tools and investigations. People in Maple still see it.",
						isChecked: model.draft.agentAccess,
						isDisabled: model.isSaving,
						onToggle: Message.ToggledAgentAccess(),
					}),
					switchRow(h, {
						id: "data-source-agent-pii",
						label: "Agents may read personal data",
						description:
							"Off drops fields marked as personal data (emails, names) from what agents get back.",
						isChecked: model.draft.agentPii,
						isDisabled: model.isSaving || !model.draft.agentAccess,
						onToggle: Message.ToggledAgentPii(),
					}),
				]),
			]),
		]),
		hstack(h, { gap: "2", justify: "end" }, [
			button(
				h,
				{
					variant: "ghost",
					size: "sm",
					isDisabled: model.isSaving,
					attributes: [h.OnClick(Message.ClickedBack())],
				},
				["Cancel"],
			),
			button(
				h,
				{ size: "sm", isLoading: model.isSaving, attributes: [h.OnClick(Message.ClickedSubmit())] },
				[isEditing ? "Test and save" : "Test and connect"],
			),
		]),
		typography(h, { size: "xs", tone: "muted", as: "p", className: "text-right font-prose" }, [
			"Maple tests the connection before saving. Nothing is saved when the test fails.",
		]),
	])
}
