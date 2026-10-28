import { PrReviewCategory, PrReviewRepositoryConfig } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Select from "../../../ui/select"
import { ALL_CATEGORIES, configFromState, FormState, Mode, sameState, stateFromConfig } from "./state"

// `ReviewRulesForm` as a Submodel: the edited state,
// what was last saved, and the save in flight. The page performs the save (`OutMessage.Saved`)
// and reports back with `completeSave`; a refetched config arrives through `syncConfig`.

export const TextField = Schema.Literals([
	"instructions",
	"ignorePaths",
	"dailyLimit",
	"automaticReviewLimit",
])
export type TextField = typeof TextField.Type
export const SelectField = Schema.Literals([
	"minInlineSeverity",
	"feedbackScope",
	"reviewDrafts",
	"reviewExternalContributors",
	"blockOnContractBreaks",
	"postMergeCheck",
])
export type SelectField = typeof SelectField.Type
export const SwitchField = Schema.Literals([
	"reviewDrafts",
	"reviewExternalContributors",
	"blockOnContractBreaks",
	"postMergeCheck",
])
export type SwitchField = typeof SwitchField.Type

export const Model = Schema.Struct({
	id: Schema.String,
	mode: Mode,
	/** The config the form was last built from (`seenConfig`). */
	config: PrReviewRepositoryConfig,
	/** The organization's rules, named in a repository form's "Organization default" options. */
	inherited: Schema.NullOr(PrReviewRepositoryConfig),
	state: FormState,
	saved: FormState,
	/** What was last sent, so a refetch landing after the save keeps any edit made since. */
	submitted: Schema.NullOr(FormState),
	error: Schema.NullOr(Schema.String),
	isSaving: Schema.Boolean,
	/** Base UI field state the text controls mirror (`data-focused`, `data-touched`). */
	focused: Schema.NullOr(TextField),
	touched: Schema.Array(TextField),
	selects: Schema.Record(Schema.String, Select.Model),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ChangedText: { field: TextField, value: Schema.String },
	FocusedText: { field: TextField },
	BlurredText: { field: TextField },
	ToggledCategory: { category: PrReviewCategory },
	ToggledInheritCategories: {},
	ToggledSwitch: { field: SwitchField },
	GotSelectMessage: { field: SelectField, message: Select.Message },
	ClickedReset: {},
	ClickedSave: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Saved: { config: PrReviewRepositoryConfig } })
export type OutMessage = typeof OutMessage.Type

const SELECTS: ReadonlyArray<SelectField> = SelectField.literals

export const init = (
	id: string,
	mode: Mode,
	config: PrReviewRepositoryConfig,
	inherited: PrReviewRepositoryConfig | null,
): Model => {
	const state = stateFromConfig(mode, config)
	return {
		id,
		mode,
		config,
		inherited,
		state,
		saved: state,
		submitted: null,
		error: null,
		isSaving: false,
		focused: null,
		touched: [],
		selects: Object.fromEntries(
			SELECTS.map((field) => [
				field,
				Select.init(`${id}-${field}`, { value: state[field], selectedIndex: null }),
			]),
		),
	}
}

/** The selects follow the state they show. */
const withState = (model: Model, state: FormState): Model => ({
	...model,
	state,
	selects: Object.fromEntries(
		SELECTS.map((field) => [
			field,
			{
				...(model.selects[field] ??
					Select.init(`${model.id}-${field}`, { value: state[field], selectedIndex: null })),
				value: state[field],
			},
		]),
	),
})

/** A refetched config replaces the form unless it was edited after Save. */
export const syncConfig = (model: Model, config: PrReviewRepositoryConfig): Model => {
	if (config === model.config) return model
	const fresh = stateFromConfig(model.mode, config)
	const keep = model.submitted !== null && !sameState(model.state, model.submitted)
	const next = { ...model, config, saved: fresh, submitted: null }
	return keep ? next : withState(next, fresh)
}

/** The page's save answered: `None` saved, `Some` is the message to show. */
export const completeSave = (model: Model, failure: Option.Option<string>): Model => ({
	...model,
	isSaving: false,
	error: Option.getOrNull(failure),
})

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const edit = (model: Model, patch: Partial<FormState>): Return => ({
	model: { ...withState(model, { ...model.state, ...patch }), error: null },
})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ChangedText: ({ field, value }) => edit(model, { [field]: value }),
		FocusedText: ({ field }) => ({ model: { ...model, focused: field } }),
		BlurredText: ({ field }) => ({
			model: {
				...model,
				focused: model.focused === field ? null : model.focused,
				touched: model.touched.includes(field) ? model.touched : [...model.touched, field],
			},
		}),
		ToggledCategory: ({ category }) => {
			const current = model.state.categories ?? parentCategories(model)
			return edit(model, {
				categories: current.includes(category)
					? current.filter((value) => value !== category)
					: [...current, category],
			})
		},
		ToggledInheritCategories: () =>
			edit(model, { categories: model.state.categories === null ? parentCategories(model) : null }),
		ToggledSwitch: ({ field }) => edit(model, { [field]: model.state[field] === "on" ? "off" : "on" }),
		GotSelectMessage: ({ field, message: inner }) => {
			const select =
				model.selects[field] ??
				Select.init(`${model.id}-${field}`, { value: model.state[field], selectedIndex: null })
			const next = Select.update(select, inner)
			const lifted = { ...model, selects: { ...model.selects, [field]: next.model } }
			const commands = Command.mapMessages(next.commands ?? [], (m) =>
				Message.GotSelectMessage({ field, message: m }),
			)
			return next.outMessage === undefined
				? { model: lifted, commands }
				: { ...edit(lifted, { [field]: next.outMessage.value }), commands }
		},
		ClickedReset: () => ({ model: { ...withState(model, model.saved), error: null } }),
		ClickedSave: () =>
			model.isSaving
				? { model }
				: {
						model: { ...model, isSaving: true, submitted: model.state, error: null },
						outMessage: OutMessage.Saved({ config: configFromState(model.mode, model.state) }),
					},
	})

export const parentCategories = (model: Model) => model.inherited?.categories ?? ALL_CATEGORIES
