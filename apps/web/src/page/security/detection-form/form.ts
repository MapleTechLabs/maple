import { AlertDestinationId, AlertSeverity } from "@maple/domain/http"
import { Schema } from "effect"

/** The typed inputs, addressed by name from one Message. */
export const TextField = Schema.Literals(["name", "action", "threshold", "windowMinutes"])
export type TextField = typeof TextField.Type

/** The filters a select sets; its empty value is "Any". */
export const SelectField = Schema.Literals(["provider", "category", "outcome"])
export type SelectField = typeof SelectField.Type

export const Form = Schema.Struct({
	name: Schema.String,
	/** `""` counts every platform; likewise the category and the outcome. */
	provider: Schema.String,
	category: Schema.String,
	outcome: Schema.String,
	/** The platform's own action name, matched exactly; empty counts every action. */
	action: Schema.String,
	/** As typed: the count and the window are numbers only once they are valid. */
	threshold: Schema.String,
	windowMinutes: Schema.String,
	severity: AlertSeverity,
	destinationIds: Schema.Array(AlertDestinationId),
	enabled: Schema.Boolean,
})
export type Form = typeof Form.Type

/** A new detection: every event, one or more in 5 minutes, a warning, on, nobody notified yet. */
export const emptyForm = (fields: Partial<Form> = {}): Form => ({
	name: "",
	provider: "",
	category: "",
	outcome: "",
	action: "",
	threshold: "1",
	windowMinutes: "5",
	severity: "warning",
	destinationIds: [],
	enabled: true,
	...fields,
})
