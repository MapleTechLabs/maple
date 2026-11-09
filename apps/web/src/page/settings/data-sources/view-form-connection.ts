import type { DataSourceKind } from "@maple/domain/data-sources"
import type { Html, HtmlBuilder } from "foldkit/html"
import { grid } from "@maple/views/ui/grid"
import { separator } from "@maple/views/ui/display"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { clerkInstanceOf } from "./draft"
import type { DraftField, Message, Model } from "./model"
import { textField } from "./view-field"

// The connection half of the form: what each kind needs to reach the source.

type H = HtmlBuilder<Message>
type Errors = Partial<Record<DraftField, string>>

const note = (h: H, text: string): Html =>
	typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [text])

const clickHouseFields = (h: H, model: Model, isEditing: boolean, errors: Errors): ReadonlyArray<Html> => [
	textField(h, {
		name: "url",
		label: "URL",
		value: model.draft.url,
		error: errors.url,
		placeholder: "https://your-clickhouse.example.com:8443",
		description:
			"The HTTP interface, usually https:// on port 8443. Plain http:// works but sends the password unencrypted.",
		isDisabled: model.isSaving,
	}),
	grid(h, { sm: 2, gap: "3" }, [
		textField(h, {
			name: "user",
			label: "User",
			value: model.draft.user,
			error: errors.user,
			isDisabled: model.isSaving,
		}),
		textField(h, {
			name: "database",
			label: "Database",
			value: model.draft.database,
			error: errors.database,
			isDisabled: model.isSaving,
		}),
	]),
	textField(h, {
		name: "password",
		label: "Password",
		type: "password",
		value: model.draft.password,
		error: errors.password,
		placeholder: isEditing ? "Leave blank to keep the current password" : "Optional",
		isDisabled: model.isSaving,
	}),
	note(
		h,
		"Use a read-only user. Maple only runs SELECT queries, and the test warns when the user can write.",
	),
]

const INSTANCE_NOTE = {
	production: "Production instance (sk_live_ key).",
	development: "Development instance (sk_test_ key).",
} as const

const clerkFields = (h: H, model: Model, isEditing: boolean, errors: Errors): ReadonlyArray<Html> => {
	const instance = clerkInstanceOf(model.draft.secretKey)
	return [
		textField(h, {
			name: "secretKey",
			label: "Secret key",
			type: "password",
			value: model.draft.secretKey,
			error: errors.secretKey,
			placeholder: isEditing ? "Leave blank to keep the current key" : "sk_live_...",
			description:
				instance === null
					? "From the API keys page of your Clerk dashboard."
					: INSTANCE_NOTE[instance],
			isDisabled: model.isSaving,
		}),
		note(
			h,
			"Clerk secret keys can also write to your instance. Maple only calls Clerk's read endpoints with it, and stores it encrypted.",
		),
	]
}

export const connectionFields = (
	h: H,
	model: Model,
	kind: DataSourceKind,
	isEditing: boolean,
	errors: Errors,
): ReadonlyArray<Html> => [
	separator(h, "horizontal", undefined),
	vstack(h, { gap: "4" }, [
		typography(h, { size: "sm", weight: "medium" }, ["Connection"]),
		...(kind === "clickhouse"
			? clickHouseFields(h, model, isEditing, errors)
			: clerkFields(h, model, isEditing, errors)),
	]),
]
