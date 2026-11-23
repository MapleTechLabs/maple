import * as Policy from "@maple/domain/policy"
import { GroupingConfigDocument, GroupingRulesUpdateRequest } from "@maple/domain/http"
import {
	GroupingConfig,
	GroupingRuleKind,
	MAX_GROUPING_RULES,
	OrgGroupingRule,
} from "@maple/domain/tinybird/grouping-rules"
import { Array as Arr, Effect, Option, Record as Rec, Result, Schema, String as Str } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, settleTo, toLoadFailure } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { PageOutMessage, type PageReturn } from "../../contract"
import { revisitData } from "../kit/revisit"

// The org's error grouping rules (`GroupingConfig`): the stored list, the form's copy of it, and
// what the server said about the last save, per rule where it named one.

export const RULE_FIELDS = ["service", "exceptionType", "message", "frame", "title"] as const
export const RuleField = Schema.Literals(RULE_FIELDS)
export type RuleField = typeof RuleField.Type

/** One rule as the form edits it: every pattern a string, empty meaning "not set". */
export const RuleDraft = Schema.Struct({
	id: Schema.String,
	kind: GroupingRuleKind,
	service: Schema.String,
	exceptionType: Schema.String,
	message: Schema.String,
	frame: Schema.String,
	title: Schema.String,
})
export type RuleDraft = typeof RuleDraft.Type

/** A save the server refused: its message, and each problem with the rule it names (or none). */
export const SaveRefusal = Schema.Struct({
	message: Schema.String,
	problems: Schema.Array(Schema.Struct({ ruleId: Schema.NullOr(Schema.String), text: Schema.String })),
})
export type SaveRefusal = typeof SaveRefusal.Type

export const RulesData = AsyncData.Schema(GroupingConfigDocument, LoadFailure)

export const Model = Schema.Struct({
	rules: RulesData.schema,
	/** The editable rules, `null` until the stored ones load. */
	draft: Schema.NullOr(Schema.Array(RuleDraft)),
	isDirty: Schema.Boolean,
	isSaving: Schema.Boolean,
	refusal: Schema.NullOr(SaveRefusal),
	/** When the stored rules the draft started from were saved: a save is refused if they moved on. */
	baseUpdatedAt: GroupingConfigDocument.fields.updatedAt,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	CompletedFetchRules: { result: Schema.Result(GroupingConfigDocument, LoadFailure) },
	ClickedRetryRules: {},
	ClickedAddRule: {},
	ClickedRemoveRule: { id: Schema.String },
	ChangedRuleKind: { id: Schema.String, value: Schema.String },
	ChangedRuleField: { id: Schema.String, field: RuleField, value: Schema.String },
	ClickedSaveRules: {},
	CompletedSaveRules: { result: Schema.Result(GroupingConfigDocument, SaveRefusal) },
})
export type Message = typeof Message.Type

type Return = PageReturn<Model, Message>

/** The viewer may change the grouping rules (`error_policy:manage`), as the server checks. */
export const canManageGrouping = (grants: ReadonlyArray<Policy.Permission>): boolean =>
	Policy.has(grants, "error_policy:manage")

/** `details` reads `<rule id>: <problem>`; a line naming no rule in the list stays org-wide. */
export const problemsOf = (
	details: ReadonlyArray<string>,
	ruleIds: ReadonlyArray<string>,
): SaveRefusal["problems"] =>
	Arr.map(details, (detail) => {
		const at = Option.getOrNull(Str.indexOf(": ")(detail))
		const ruleId = at === null ? null : Str.slice(0, at)(detail)
		return at !== null && ruleId !== null && ruleIds.includes(ruleId)
			? { ruleId, text: Str.slice(at + 2)(detail) }
			: { ruleId: null, text: detail }
	})

const FetchGroupingRules = Command.define("FetchGroupingRules", {
	messages: [Message.CompletedFetchRules],
	execute: Effect.flatMap(MapleInternalApiClient, (client) => client.errors.getGroupingRules()).pipe(
		settleTo((result) => Message.CompletedFetchRules({ result })),
	),
})

const SaveGroupingRules = Command.define("SaveGroupingRules", {
	args: { config: GroupingConfig, expectedUpdatedAt: GroupingConfigDocument.fields.updatedAt },
	messages: [Message.CompletedSaveRules],
	execute: ({ config, expectedUpdatedAt }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.errors.updateGroupingRules({
				payload: new GroupingRulesUpdateRequest({ rules: config.rules, expectedUpdatedAt }),
			}),
		).pipe(
			Effect.catchTags({
				"@maple/http/errors/ErrorValidationError": (error) =>
					Effect.fail<SaveRefusal>({
						message: error.message,
						problems: problemsOf(
							error.details,
							Arr.map(config.rules, (rule) => rule.id),
						),
					}),
				"@maple/http/errors/ErrorForbiddenError": (error) =>
					Effect.fail<SaveRefusal>({ message: error.message, problems: [] }),
			}),
			Effect.mapError((error): SaveRefusal =>
				"problems" in error ? error : { message: toLoadFailure(error).message, problems: [] },
			),
			Effect.result,
			Effect.map((result) => Message.CompletedSaveRules({ result })),
		),
})

export const init = (): Return => ({
	model: {
		rules: AsyncData.Loading(),
		draft: null,
		isDirty: false,
		isSaving: false,
		refusal: null,
		baseUpdatedAt: null,
	},
	commands: [FetchGroupingRules()],
})

/** Back on the tab: the stored rules load again behind an unsaved draft, which is kept. */
export const revisit = (model: Model): Return => {
	const rules = revisitData(model.rules, FetchGroupingRules)
	return { model: { ...model, rules: rules.data }, commands: rules.commands }
}

const draftOf = (rule: OrgGroupingRule): RuleDraft => ({
	id: rule.id,
	kind: rule.kind,
	service: rule.service ?? "",
	exceptionType: rule.exceptionType ?? "",
	message: rule.message ?? "",
	frame: rule.frame ?? "",
	title: rule.title ?? "",
})

/** The fields a kind reads: a frame rule reads only a service and a frame. */
export const fieldsOf = (kind: RuleDraft["kind"]): ReadonlyArray<RuleField> =>
	kind === "merge" ? RULE_FIELDS : ["service", "frame"]

const set = (value: string) => {
	const trimmed = Str.trim(value)
	return trimmed === "" ? undefined : trimmed
}

/** The draft as the API takes it: empty patterns dropped, fields the kind ignores left out. */
export const configOf = (draft: ReadonlyArray<RuleDraft>): GroupingConfig =>
	new GroupingConfig({
		rules: Arr.map(draft, (rule) => {
			const reads = fieldsOf(rule.kind)
			// Only the fields the kind reads and the user filled in go to the API.
			const patterns = Rec.fromEntries(
				Arr.filterMap(reads, (name) =>
					Option.match(Option.fromNullishOr(set(rule[name])), {
						onNone: () => Result.failVoid,
						onSome: (value) => Result.succeed([name, value] as const),
					}),
				),
			)
			return new OrgGroupingRule({ id: rule.id, kind: rule.kind, ...patterns })
		}),
	})

/** A short id no other rule holds; it never changes once the rule exists, so its issues keep their key. */
export const nextRuleId = (draft: ReadonlyArray<RuleDraft>): string => {
	const taken = new Set(Arr.map(draft, (rule) => rule.id))
	const free = Arr.findFirst(Arr.range(1, draft.length + 1), (n) => !taken.has(`rule-${n}`))
	return `rule-${Option.getOrElse(free, () => draft.length + 1)}`
}

const asKind = Schema.decodeUnknownOption(GroupingRuleKind)

const edit = (
	model: Model,
	canManage: boolean,
	change: (draft: ReadonlyArray<RuleDraft>) => ReadonlyArray<RuleDraft>,
): Return =>
	model.draft === null || !canManage || model.isSaving
		? { model }
		: { model: { ...model, draft: change(model.draft), isDirty: true } }

const editRule = (id: string, change: (rule: RuleDraft) => RuleDraft) => (draft: ReadonlyArray<RuleDraft>) =>
	Arr.map(draft, (rule) => (rule.id === id ? change(rule) : rule))

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

export const update = (model: Model, message: Message, grants: ReadonlyArray<Policy.Permission>): Return => {
	const canManage = canManageGrouping(grants)
	return Message.match<Return>(message, {
		CompletedFetchRules: ({ result }) => {
			const rules = AsyncData.settle(model.rules, result)
			// An untouched form follows the stored rules; edits are kept.
			if (model.isDirty) return { model: { ...model, rules } }
			const document = Option.getOrNull(AsyncData.getData(rules))
			return {
				model: {
					...model,
					rules,
					draft: document === null ? model.draft : Arr.map(document.rules, draftOf),
					baseUpdatedAt: document === null ? model.baseUpdatedAt : document.updatedAt,
				},
			}
		},
		ClickedRetryRules: () => ({
			model: { ...model, rules: AsyncData.isFailure(model.rules) ? model.rules : AsyncData.Loading() },
			commands: [FetchGroupingRules()],
		}),
		ClickedAddRule: () =>
			edit(model, canManage, (draft) =>
				draft.length >= MAX_GROUPING_RULES
					? draft
					: [
							...draft,
							{
								id: nextRuleId(draft),
								kind: "merge",
								service: "",
								exceptionType: "",
								message: "",
								frame: "",
								title: "",
							},
						],
			),
		ClickedRemoveRule: ({ id }) =>
			edit(model, canManage, (draft) => Arr.filter(draft, (rule) => rule.id !== id)),
		ChangedRuleKind: ({ id, value }) =>
			Option.match(asKind(value), {
				onNone: () => ({ model }),
				onSome: (kind) =>
					edit(
						model,
						canManage,
						editRule(id, (rule) => ({ ...rule, kind })),
					),
			}),
		ChangedRuleField: ({ id, field, value }) =>
			edit(
				model,
				canManage,
				editRule(id, (rule) => ({ ...rule, [field]: value })),
			),
		ClickedSaveRules: () =>
			model.draft === null || model.isSaving || !canManage
				? { model }
				: {
						model: { ...model, isSaving: true, refusal: null },
						commands: [
							SaveGroupingRules({
								config: configOf(model.draft),
								expectedUpdatedAt: model.baseUpdatedAt,
							}),
						],
					},
		CompletedSaveRules: ({ result }) =>
			Result.match(result, {
				onSuccess: (document) => ({
					model: {
						...model,
						isSaving: false,
						isDirty: false,
						rules: AsyncData.succeed(document),
						draft: Arr.map(document.rules, draftOf),
						baseUpdatedAt: document.updatedAt,
					},
					outMessage: toast("success", "Grouping rules saved"),
				}),
				onFailure: (refusal) => ({ model: { ...model, isSaving: false, refusal } }),
			}),
	})
}
