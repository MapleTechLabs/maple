import { Schema } from "effect"

// The scrape-target form's field names and auth types (shared by the Model and the Messages).

export const AuthType = Schema.Literals(["none", "bearer", "basic"])
export type AuthType = typeof AuthType.Type

export const FormFieldName = Schema.Literals([
	"name",
	"serviceName",
	"url",
	"interval",
	"token",
	"username",
	"password",
])
export type FormFieldName = typeof FormFieldName.Type
