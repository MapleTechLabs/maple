import { SOURCE_LIMITS } from "@maple/domain/http"
import { V2Source, type V2SourceUpdateParams } from "@maple/domain/http/v2"
import { SourceAttributeMode, SourceSignal } from "@maple/domain/primitives"
import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as ToggleGroup from "../../../ui/toggle-group"
import { SIGNALS } from "./shared"

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
	signals: existing?.allowed_signals ?? SIGNALS.map((signal) => signal.value),
	rateLimitText:
		existing === null || existing.rate_limit_rps === null ? "" : String(existing.rate_limit_rps),
	attributes:
		existing === null
			? []
			: existing.resource_attributes.map((attribute, index) => ({
					rowId: `existing-${index}`,
					...attribute,
				})),
	expiry: existing !== null && existing.expires_at !== null ? "keep" : "never",
	nextRowId: 0,
})

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
	EXPIRY_CHOICES.filter(
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
					? model.signals.filter((value) => value !== signal)
					: [...model.signals, signal],
			},
		}),
		ChangedRateLimit: ({ value }) => ({ model: { ...model, rateLimitText: value } }),
		ChangedAttribute: ({ rowId, field, value }) => ({
			model: {
				...model,
				attributes: model.attributes.map((row) =>
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
					attributes: model.attributes.map((entry) =>
						entry.rowId === rowId ? { ...entry, mode } : entry,
					),
				}),
				model,
				(child) => Message.GotModeMessage({ rowId, message: child }),
			)
		},
		ClickedRemoveAttribute: ({ rowId }) => ({
			model: { ...model, attributes: model.attributes.filter((row) => row.rowId !== rowId) },
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
					expiryChoicesOf(model).map((choice) => choice.value),
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
	const trimmedRate = model.rateLimitText.trim()
	const rateLimit = trimmedRate.length === 0 ? null : Number(trimmedRate)
	const rateLimitValid =
		rateLimit === null ||
		(Number.isInteger(rateLimit) && rateLimit >= 1 && rateLimit <= MAX_RATE_LIMIT_RPS)
	const filled = model.attributes.filter((attribute) => attribute.key.trim().length > 0)
	const keys = filled.map((attribute) => attribute.key.trim())
	const reserved = keys.find((key) => {
		const lower = key.toLowerCase()
		return lower === "org_id" || lower.startsWith("maple_")
	})
	const missingValue = filled.find((attribute) => attribute.value.length === 0)
	const duplicate = keys.find((key, index) => keys.indexOf(key) !== index)
	const attributeProblem =
		reserved !== undefined
			? `"${reserved}" is reserved by Maple.`
			: duplicate !== undefined
				? `"${duplicate}" is listed twice.`
				: missingValue !== undefined
					? `Give "${missingValue.key.trim()}" a value, or remove it.`
					: null
	const valid = model.signals.length > 0 && rateLimitValid && attributeProblem === null
	const payload: V2SourceUpdateParams = {
		allowed_signals:
			model.signals.length === SIGNALS.length
				? null
				: SIGNALS.map((signal) => signal.value).filter((signal) => model.signals.includes(signal)),
		rate_limit_rps: rateLimit,
		resource_attributes: filled.map(({ key, value, mode }) => ({ key: key.trim(), value, mode })),
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
