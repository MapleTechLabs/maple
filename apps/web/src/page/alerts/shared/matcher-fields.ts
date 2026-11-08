import type { V2AlertSilenceMatchers } from "@maple/domain/http/v2"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { fieldDescription, fieldError, fieldLabel, type FieldIds, input } from "@maple/views/ui/field"
import type { FieldState } from "@maple/views/ui/input"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// The typed matcher fields (services, environments, tags) the silence and maintenance window
// dialogs share, and the text field both dialogs draw them with.

export const MatcherField = Schema.Literals(["services", "tags", "environments"])
export type MatcherField = typeof MatcherField.Type

/** The matchers as typed: comma-separated lists. */
export const TypedMatchers = Schema.Struct({
	services: Schema.String,
	tags: Schema.String,
	environments: Schema.String,
})
export type TypedMatchers = typeof TypedMatchers.Type

export const emptyTypedMatchers: TypedMatchers = { services: "", tags: "", environments: "" }

/** Saved matchers as the fields show them. */
export const typedFromMatchers = (matchers: V2AlertSilenceMatchers): TypedMatchers => ({
	services: Arr.join(matchers.services ?? [], ", "),
	tags: Arr.join(matchers.tags ?? [], ", "),
	environments: Arr.join(matchers.environments ?? [], ", "),
})

const splitList = (value: string): ReadonlyArray<string> =>
	Arr.dedupe(Arr.filter(Arr.map(Str.split(value, ","), Str.trim), Str.isNonEmpty))

/** The matchers the fields describe; an empty field is left out. */
export const matchersFromTyped = (typed: TypedMatchers): V2AlertSilenceMatchers => {
	const services = splitList(typed.services)
	const tags = splitList(typed.tags)
	const environments = splitList(typed.environments)
	return {
		...(services.length === 0 ? undefined : { services }),
		...(tags.length === 0 ? undefined : { tags }),
		...(environments.length === 0 ? undefined : { environments }),
	}
}

export const hasMatchers = (matchers: V2AlertSilenceMatchers): boolean =>
	(matchers.rule_ids?.length ?? 0) +
		(matchers.services?.length ?? 0) +
		(matchers.tags?.length ?? 0) +
		(matchers.environments?.length ?? 0) >
	0

const stateOf = (value: string, isInvalid = false): FieldState => ({
	isInvalid,
	isDirty: false,
	isFilled: value !== "",
	isFocused: false,
	isTouched: false,
})

export type DialogTextFieldOptions<M> = Readonly<{
	idPrefix: string
	name: string
	label: string
	value: string
	placeholder: string
	onInput: (value: string) => M
	type?: string
	description?: string
	error?: Option.Option<string>
	isDisabled?: boolean
}>

/** A labelled dialog text field with an optional description and error; `idPrefix` keeps ids unique. */
export const dialogTextField = <M>(h: HtmlBuilder<M>, options: DialogTextFieldOptions<M>): Html => {
	const fieldIds: FieldIds = {
		control: `${options.idPrefix}-${options.name}`,
		label: `${options.idPrefix}-${options.name}-label`,
		error: `${options.idPrefix}-${options.name}-error`,
		...(options.description === undefined
			? undefined
			: { description: `${options.idPrefix}-${options.name}-description` }),
	}
	const error = options.error ?? Option.none()
	const state = stateOf(options.value, Option.isSome(error))
	return vstack(h, { gap: "1.5" }, [
		fieldLabel(h, { ids: fieldIds, className: "text-xs", state }, [options.label]),
		input(h, {
			ids: fieldIds,
			state,
			attributes: [
				h.Value(options.value),
				h.Placeholder(options.placeholder),
				h.OnInput(options.onInput),
				h.Attribute("autocomplete", "off"),
				...(options.type === undefined ? [] : [h.Type(options.type)]),
				...(options.isDisabled === true ? [h.Disabled(true)] : []),
			],
		}),
		...(options.description === undefined
			? []
			: [fieldDescription(h, { ids: fieldIds, state }, [options.description])]),
		...Option.toArray(
			Option.map(error, (message) =>
				fieldError(h, { ids: fieldIds, state, attributes: [h.Role("alert")] }, [message]),
			),
		),
	])
}

const MATCHER_FIELDS: ReadonlyArray<{ field: MatcherField; label: string; placeholder: string }> = [
	{ field: "services", label: "Services", placeholder: "checkout, payments" },
	{ field: "environments", label: "Environments", placeholder: "production" },
	{ field: "tags", label: "Tags", placeholder: "database" },
]

/** The services, environments and tags fields, then how they combine. */
export const matcherFields = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		idPrefix: string
		typed: TypedMatchers
		onInput: (field: MatcherField, value: string) => M
		isDisabled?: boolean
	}>,
): ReadonlyArray<Html> => [
	...Arr.map(MATCHER_FIELDS, ({ field, label, placeholder }) =>
		dialogTextField(h, {
			idPrefix: options.idPrefix,
			name: field,
			label,
			value: options.typed[field],
			placeholder,
			onInput: (value) => options.onInput(field, value),
			isDisabled: options.isDisabled,
		}),
	),
	typography(h, { size: "xs", tone: "muted" }, [
		"Fill in at least one. Every listed field must match: a rule's services and environments all listed, and one of its tags.",
	]),
]
