import { SOURCE_LIMITS } from "@maple/domain/http"
import { V2Source, type V2SourceUpdateParams } from "@maple/domain/http/v2"
import { SourceAttributeMode, SourceSignal } from "@maple/domain/primitives"
import { Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { SIGNALS } from "./shared"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// The rules draft and its outcome.

export const { maxResourceAttributes: MAX_ATTRIBUTES, maxRateLimitRps: MAX_RATE_LIMIT_RPS } = SOURCE_LIMITS

// An array, not an object: numeric-looking object keys would sort ahead of "never".
export const EXPIRY_CHOICES = [
	{ value: "keep", label: "Keep current" },
	{ value: "never", label: "Never" },
	{ value: "7", label: "7 days" },
	{ value: "30", label: "30 days" },
	{ value: "90", label: "90 days" },
] as const
export const ExpiryChoice = Schema.Literals(["keep", "never", "7", "30", "90"])
export type ExpiryChoice = typeof ExpiryChoice.Type
export const isExpiryChoice = Schema.is(ExpiryChoice)

export const AttributeDraft = Schema.Struct({
	rowId: Schema.String,
	key: Schema.String,
	value: Schema.String,
	mode: SourceAttributeMode,
})
export type AttributeDraft = typeof AttributeDraft.Type

export const Model = Schema.Struct({
	/** The source being edited, or `null` on create. */
	existing: Schema.NullOr(V2Source),
	signals: Schema.Array(SourceSignal),
	rateLimitText: Schema.String,
	attributes: Schema.Array(AttributeDraft),
	expiry: ExpiryChoice,
	/** Row keys for added attributes. */
	nextRowId: Schema.Number,
})
export type Model = typeof Model.Type

export const AttributeField = Schema.Literals(["key", "value"])

export const Message = defineMessageUnion({
	ToggledSignal: { signal: SourceSignal },
	ChangedRateLimit: { value: Schema.String },
	ChangedAttribute: { rowId: Schema.String, field: AttributeField, value: Schema.String },
	GotModeMessage: { rowId: Schema.String, message: ToggleGroup.Message },
	ClickedRemoveAttribute: { rowId: Schema.String },
	ClickedAddAttribute: {},
	GotExpiryMessage: { message: ToggleGroup.Message },
})
export type Message = typeof Message.Type

/** `useRulesDraft(existing)`. */
export const init = (existing: V2Source | null): Model => ({
	existing,
	signals: existing?.allowed_signals ?? Arr.map(SIGNALS, (signal) => signal.value),
	rateLimitText:
		existing === null || existing.rate_limit_rps === null ? "" : String(existing.rate_limit_rps),
	attributes:
		existing === null
			? []
			: Arr.map(existing.resource_attributes, (attribute, index) => ({
					rowId: `existing-${index}`,
					...attribute,
				})),
	expiry: existing !== null && existing.expires_at !== null ? "keep" : "never",
	nextRowId: 0,
})

/** The draft differs from the source it was built from (row ids and signal order aside). */
export const isRulesDirty = (model: Model): boolean => {
	const comparable = (draft: Model) =>
		encodeJson([
			[...draft.signals].sort(),
			Str.trim(draft.rateLimitText),
			Arr.map(draft.attributes, ({ key, value, mode }) => [key, value, mode]),
			draft.expiry,
		])
	return comparable(model) !== comparable(init(model.existing))
}

const DAY_MS = 86_400_000

type Return = Update.Return<Model, Message>

/** The modes and expiry groups are controlled: the pressed value comes from the draft. */
export const toggleModel = (
	label: string,
	values: ReadonlyArray<string>,
	selected: string,
): ToggleGroup.Model => ({
	label,
	isMultiple: false,
	values: [selected],
	highlightedIndex: Math.max(0, values.indexOf(selected)),
})

export const modeGroupLabel = (attribute: AttributeDraft): string =>
	`When to write ${attribute.key || "this attribute"}`

/** The expiry choices on offer: "Keep current" only while editing a source that expires. */
export const expiryChoicesOf = (model: Model) =>
	Arr.filter(
		EXPIRY_CHOICES,
		(choice) =>
			choice.value !== "keep" || (model.existing !== null && model.existing.expires_at !== null),
	)

/** A pressed group item: `values.find((value) => value !== current)` picks the new one. */
const pick = <A extends string>(
	group: ToggleGroup.Model,
	message: ToggleGroup.Message,
	current: A,
	isValue: (value: string) => value is A,
	set: (value: A) => Model,
	model: Model,
	wrap: (message: ToggleGroup.Message) => Message,
): Return => {
	const step = ToggleGroup.update(group, message)
	const commands = Command.mapMessages(step.commands ?? [], wrap)
	if (message._tag !== "ClickedItem" || message.value === current || !isValue(message.value))
		return { model, commands }
	return { model: set(message.value), commands }
}

const isMode = Schema.is(SourceAttributeMode)

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ToggledSignal: ({ signal }) => ({
			model: {
				...model,
				signals: model.signals.includes(signal)
					? Arr.filter(model.signals, (value) => value !== signal)
					: [...model.signals, signal],
			},
		}),
		ChangedRateLimit: ({ value }) => ({ model: { ...model, rateLimitText: value } }),
		ChangedAttribute: ({ rowId, field, value }) => ({
			model: {
				...model,
				attributes: Arr.map(model.attributes, (row) =>
					row.rowId === rowId ? { ...row, [field]: value } : row,
				),
			},
		}),
		GotModeMessage: ({ rowId, message: inner }) => {
			const row = model.attributes.find((entry) => entry.rowId === rowId)
			if (row === undefined) return { model }
			return pick(
				toggleModel(modeGroupLabel(row), ["set", "default"], row.mode),
				inner,
				row.mode,
				isMode,
				(mode) => ({
					...model,
					attributes: Arr.map(model.attributes, (entry) =>
						entry.rowId === rowId ? { ...entry, mode } : entry,
					),
				}),
				model,
				(child) => Message.GotModeMessage({ rowId, message: child }),
			)
		},
		ClickedRemoveAttribute: ({ rowId }) => ({
			model: { ...model, attributes: Arr.filter(model.attributes, (row) => row.rowId !== rowId) },
		}),
		ClickedAddAttribute: () =>
			model.attributes.length >= MAX_ATTRIBUTES
				? { model }
				: {
						model: {
							...model,
							attributes: [
								...model.attributes,
								{ rowId: `added-${model.nextRowId}`, key: "", value: "", mode: "set" },
							],
							nextRowId: model.nextRowId + 1,
						},
					},
		GotExpiryMessage: ({ message: inner }) =>
			pick(
				toggleModel(
					"Expires",
					Arr.map(expiryChoicesOf(model), (choice) => choice.value),
					model.expiry,
				),
				inner,
				model.expiry,
				isExpiryChoice,
				(expiry) => ({ ...model, expiry }),
				model,
				(child) => Message.GotExpiryMessage({ message: child }),
			),
	})

export interface RulesOutcome {
	readonly valid: boolean
	readonly rateLimitValid: boolean
	readonly attributeProblem: string | null
	readonly payload: V2SourceUpdateParams
}

/** `rulesOutcome`: validation and the wire payload derived from the draft. */
export const rulesOutcome = (model: Model): RulesOutcome => {
	const trimmedRate = Str.trim(model.rateLimitText)
	const rateLimit = trimmedRate.length === 0 ? null : Number(trimmedRate)
	const rateLimitValid =
		rateLimit === null ||
		(Number.isInteger(rateLimit) && rateLimit >= 1 && rateLimit <= MAX_RATE_LIMIT_RPS)
	const filled = Arr.filter(model.attributes, (attribute) => Str.trim(attribute.key).length > 0)
	const keys = Arr.map(filled, (attribute) => Str.trim(attribute.key))
	const reserved = keys.find((key) => {
		const lower = Str.toLowerCase(key)
		return lower === "org_id" || Str.startsWith("maple_")(lower)
	})
	const missingValue = filled.find((attribute) => attribute.value.length === 0)
	const duplicate = keys.find((key, index) => keys.indexOf(key) !== index)
	const attributeProblem =
		reserved !== undefined
			? `"${reserved}" is reserved by Maple.`
			: duplicate !== undefined
				? `"${duplicate}" is listed twice.`
				: missingValue !== undefined
					? `Give "${Str.trim(missingValue.key)}" a value, or remove it.`
					: null
	const valid = model.signals.length > 0 && rateLimitValid && attributeProblem === null
	const payload: V2SourceUpdateParams = {
		allowed_signals:
			model.signals.length === SIGNALS.length
				? null
				: Arr.filter(
						Arr.map(SIGNALS, (signal) => signal.value),
						(signal) => model.signals.includes(signal),
					),
		rate_limit_rps: rateLimit,
		resource_attributes: Arr.map(filled, ({ key, value, mode }) => ({ key: Str.trim(key), value, mode })),
	}
	return { valid, rateLimitValid, attributeProblem, payload }
}

/** "keep" leaves the stored expiry untouched (`undefined`); otherwise `null` or an ISO instant. */
export const expiresAtOf = (expiry: ExpiryChoice, nowMs: number): string | null | undefined =>
	expiry === "keep"
		? undefined
		: expiry === "never"
			? null
			: new Date(nowMs + Number(expiry) * DAY_MS).toISOString()
