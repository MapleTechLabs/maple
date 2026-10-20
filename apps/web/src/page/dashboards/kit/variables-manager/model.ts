import { DashboardVariableSchema } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Dialog from "../../../../ui/dialog"
import * as Field from "../../../../ui/field"
import * as Select from "../../../../ui/select"

// The variables manager dialog: a session of
// drafts started from the saved variables each time it opens, one draft's form expanded at a time.

export type Variable = typeof DashboardVariableSchema.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	drafts: Schema.Array(DashboardVariableSchema),
	editingIndex: Schema.NullOr(Schema.Number),
	/** Opened on a board with no variables: one blank draft, its form open, and the intro panel. */
	startedEmpty: Schema.Boolean,
	/** The open form's controls: Base UI field state and the selects. */
	name: Field.Model,
	label: Field.Model,
	defaultValue: Field.Model,
	options: Field.Model,
	attributeKey: Field.Model,
	metricNames: Field.Model,
	typeSelect: Select.Model,
	sourceSelect: Select.Model,
	metricTypeSelect: Select.Model,
})
export type Model = typeof Model.Type

export const FormField = Schema.Literals(["name", "label", "defaultValue", "options", "attributeKey", "metricNames"])
export type FormField = typeof FormField.Type

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotFieldMessage: { field: FormField, message: Field.Message },
	GotTypeSelectMessage: { message: Select.Message },
	GotSourceSelectMessage: { message: Select.Message },
	GotMetricTypeSelectMessage: { message: Select.Message },
	ToggledIncludeAll: {},
	ClickedMove: { index: Schema.Number, delta: Schema.Literals([-1, 1]) },
	ClickedEdit: { index: Schema.Number },
	ClickedDelete: { index: Schema.Number },
	ClickedAdd: {},
	SubmittedForm: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	SavedVariables: { variables: Schema.Array(DashboardVariableSchema) },
})
export type OutMessage = typeof OutMessage.Type
