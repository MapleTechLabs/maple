import * as Policy from "@maple/domain/policy"
import { MAX_GROUPING_PATTERN_CHARS, MAX_GROUPING_RULES } from "@maple/domain/tinybird/grouping-rules"
import { Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { field, fieldError, fieldLabel, input, type FieldState } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { panel } from "@maple/views/ui/panel"
import { skeletonBlock, skeletonSlowNote } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { gatedBy } from "../../kit/gated-controls"
import { adminOnlyNote, settingsSection } from "../../kit/settings-section"
import {
	fieldsOf,
	Message,
	type Model,
	type RuleDraft,
	type RuleField,
	type SaveRefusal,
} from "./grouping-rules"

// Settings > Automation's "Error grouping rules": one card per rule, its kind and patterns, then
// Save. A refused save puts each problem under the rule it names.

type H = HtmlBuilder<Message>
export type GroupingRulesInputs = Readonly<{ canManage: boolean; isKnownMember: boolean }>

const KIND_OPTIONS = [
	nativeOption("merge", "Merge into one issue"),
	nativeOption("library-frames", "Treat frames as library code"),
	nativeOption("app-frames", "Treat frames as app code"),
]

const FIELD_COPY = {
	service: { label: "Service", placeholder: "Every service" },
	exceptionType: { label: "Exception type", placeholder: "Any type" },
	message: { label: "Message", placeholder: "Any message" },
	frame: { label: "Frame", placeholder: "Any frame" },
	title: { label: "Title", placeholder: "Shown on the issues it groups" },
} satisfies Record<RuleField, { label: string; placeholder: string }>

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}

/** The server writes a problem in lower case after the rule id; shown alone, it reads as a sentence. */
const sentence = (text: string): string => `${Str.capitalize(text)}${Str.endsWith(".")(text) ? "" : "."}`

const ruleProblems = (refusal: SaveRefusal | null, ruleId: string): ReadonlyArray<string> =>
	refusal === null
		? []
		: Arr.flatMap(refusal.problems, (problem) => (problem.ruleId === ruleId ? [problem.text] : []))

const ruleField = (h: H, rule: RuleDraft, name: RuleField, isLocked: boolean): Html => {
	const ids = {
		control: `grouping-rule-${rule.id}-${name}`,
		label: `grouping-rule-${rule.id}-${name}-label`,
		error: `grouping-rule-${rule.id}-error`,
	}
	const state = { ...IDLE, isFilled: rule[name] !== "" }
	return field(h, { state, className: name === "title" ? "sm:col-span-2" : undefined }, [
		fieldLabel(h, { ids, state }, FIELD_COPY[name].label),
		input(h, {
			ids,
			state,
			isDisabled: isLocked,
			attributes: [
				h.Value(rule[name]),
				h.Placeholder(FIELD_COPY[name].placeholder),
				h.Attribute("maxlength", String(name === "title" ? 200 : MAX_GROUPING_PATTERN_CHARS)),
				h.Attribute("spellcheck", "false"),
				h.OnInput((value) => Message.ChangedRuleField({ id: rule.id, field: name, value })),
			],
		}),
	])
}

const ruleCard = (h: H, model: Model, rule: RuleDraft, inputs: GroupingRulesInputs): Html => {
	const isLocked = !inputs.canManage || model.isSaving
	const problems = ruleProblems(model.refusal, rule.id)
	const hasProblem = problems.length > 0
	return panel(h, { padded: "sm", className: "gap-3", attributes: [h.Key(rule.id)] }, [
		hstack(h, { gap: "2", justify: "between" }, [
			nativeSelect(
				h,
				{
					size: "sm",
					className: "w-full max-w-64",
					value: rule.kind,
					isDisabled: isLocked,
					attributes: [
						h.AriaLabel("Rule kind"),
						h.OnChange((value) => Message.ChangedRuleKind({ id: rule.id, value })),
					],
				},
				KIND_OPTIONS,
			),
			hstack(h, { gap: "2" }, [
				typography(h, { size: "2xs", mono: true, tone: "subtle" }, [rule.id]),
				iconButton(
					h,
					{
						label: "Remove rule",
						size: "icon-sm",
						isDisabled: isLocked,
						attributes: [h.OnClick(Message.ClickedRemoveRule({ id: rule.id }))],
					},
					[icon(h, "TrashIcon")],
				),
			]),
		]),
		h.div(
			[h.Class("grid gap-3 sm:grid-cols-2")],
			Arr.map(fieldsOf(rule.kind), (name) => ruleField(h, rule, name, isLocked)),
		),
		...(hasProblem
			? [
					fieldError(
						h,
						{
							ids: {
								control: `grouping-rule-${rule.id}`,
								label: `grouping-rule-${rule.id}-label`,
								error: `grouping-rule-${rule.id}-error`,
							},
							state: { ...IDLE, isInvalid: true },
							attributes: [h.Role("alert")],
						},
						Arr.join(Arr.map(problems, sentence), " "),
					),
				]
			: []),
	])
}

const refusalNotice = (h: H, refusal: SaveRefusal | null): ReadonlyArray<Html> => {
	if (refusal === null) return []
	const orgWide = Arr.flatMap(refusal.problems, (problem) =>
		problem.ruleId === null ? [problem.text] : [],
	)
	return [
		alert(h, { variant: "crit", size: "sm", role: "alert" }, [
			alertTitle(h, [refusal.message]),
			...(orgWide.length === 0
				? []
				: [alertDescription(h, [Arr.join(Arr.map(orgWide, sentence), " ")])]),
		]),
	]
}

const addButton = (h: H, model: Model, draft: ReadonlyArray<RuleDraft>, inputs: GroupingRulesInputs): Html =>
	gatedBy(h, inputs.canManage, "error_policy:manage", (isLocked) =>
		button(
			h,
			{
				size: "sm",
				variant: "outline",
				className: "gap-1",
				isDisabled: isLocked || model.isSaving || draft.length >= MAX_GROUPING_RULES,
				attributes: [h.OnClick(Message.ClickedAddRule())],
			},
			[icon(h, "PlusIcon"), "Add rule"],
		),
	)

const editor = (h: H, model: Model, draft: ReadonlyArray<RuleDraft>, inputs: GroupingRulesInputs): Html =>
	vstack(h, { gap: "3" }, [
		...refusalNotice(h, model.refusal),
		...(draft.length === 0
			? [emptyMessage(h, { dashed: true }, ["No grouping rules yet"])]
			: Arr.map(draft, (rule) => ruleCard(h, model, rule, inputs))),
		hstack(h, { gap: "2", justify: "between", wrap: true }, [
			addButton(h, model, draft, inputs),
			gatedBy(h, inputs.canManage, "error_policy:manage", (isLocked) =>
				button(
					h,
					{
						size: "sm",
						isLoading: model.isSaving,
						isDisabled: isLocked || !model.isDirty,
						attributes: [h.OnClick(Message.ClickedSaveRules())],
					},
					["Save rules"],
				),
			),
		]),
		...(inputs.canManage || !inputs.isKnownMember
			? []
			: [adminOnlyNote(h, [Policy.denialFor("error_policy:manage").message])]),
	])

export const groupingRulesSection = (h: H, model: Model, inputs: GroupingRulesInputs): Html =>
	settingsSection(
		h,
		{
			id: "automation-grouping-heading",
			title: "Error grouping rules",
			description: [
				"Rules merge matching errors into one issue and never split one apart. Patterns are case-insensitive, and * matches anything.",
			],
			framed: false,
		},
		[
			model.draft !== null
				? editor(h, model, model.draft, inputs)
				: AsyncData.matchData(model.rules, {
						onEmpty: () =>
							vstack(h, { gap: "2" }, [
								skeletonBlock(h, { height: "24" }),
								skeletonSlowNote(h),
							]),
						onData: () => skeletonBlock(h, { height: "24" }),
						onFailure: (failure) =>
							errorState(h, {
								failure,
								title: "Couldn't load the grouping rules",
								variant: "row",
								onRetry: Message.ClickedRetryRules(),
							}),
					}),
		],
	)

/** The section as a Submodel view, mounted by the Automation tab. */
export const view = Submodel.defineView<Model, Message, GroupingRulesInputs>((model, inputs, h) =>
	groupingRulesSection(h, model, inputs),
)
