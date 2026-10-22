import type { AiTriageSettingsDocument, OpenRouterKeyDocument } from "@maple/domain/http"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { collapsiblePanelStyles } from "@maple/ui/styles/ui/collapsible"
import { PASSES_PER_DAY_LIMITS, parseDailyLimit, RUNS_PER_DAY_LIMITS } from "../../../components/settings/ai-triage-limits"
import { limitsUpdate } from "../../../components/settings/ai-triage-limits"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { badge } from "../../../ui/display"
import { errorState } from "../../../ui/error-state"
import * as Field from "../../../ui/field"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel, input, type FieldState } from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { input as plainInput } from "../../../ui/input"
import { meter } from "../../../ui/meter"
import { panel } from "../../../ui/panel"
import * as RadioGroup from "../../../ui/radio-group"
import { settingRow } from "../../../ui/setting-row"
import { skeleton } from "../../../ui/skeleton"
import { switchControl } from "../../../ui/switch"
import { saveBar } from "../kit/save-bar"
import { settingsSection, settingsSections } from "../kit/section"
import { Message, type Model, type Provider } from "./model"
import { isLimitsDirty, limitsDraftOf } from "./update"

type H = HtmlBuilder<Message>

const ADD_ON_PRICE = "$15/month"
const IDLE: FieldState = { isInvalid: false, isDirty: false, isFilled: false, isFocused: false, isTouched: false }
const TRIAGE_DESCRIPTION =
	"When an error or anomaly incident opens, an agent investigates it with read-only tools and attaches a triage summary. Runs on the model provider above."

const fieldIds = (name: string): FieldIds => ({
	control: name,
	label: `${name}-label`,
	error: `${name}-error`,
	description: `${name}-description`,
})

// MODEL PROVIDER

const RADIO_ITEMS = [
	{ value: "managed", id: "ai-provider-managed", inputId: "ai-provider-managed-input" },
	{ value: "openrouter", id: "ai-provider-openrouter", inputId: "ai-provider-openrouter-input" },
] as const

const radioInputId = (value: Provider) => `ai-provider-${value}-input`

const toProviderMessage = (message: RadioGroup.Message): Message =>
	message._tag === "SelectedRadio" || message._tag === "PressedArrowKey"
		? Message.PickedProvider({ provider: message.value === "openrouter" ? "openrouter" : "managed" })
		: Message.CompletedFocusProvider()

const providerCard = (
	h: H,
	options: Readonly<{
		value: Provider
		selected: Provider
		title: string
		badge?: Html
		description: string
		children?: ReadonlyArray<Html>
	}>,
): Html => {
	const isSelected = options.value === options.selected
	const radioConfig: RadioGroup.RadioGroupViewConfig<Message> = {
		model: RadioGroup.init(options.selected),
		toParentMessage: toProviderMessage,
		items: RADIO_ITEMS,
	}
	return h.div(
		[
			h.Class(
				cn(
					"flex flex-col gap-3 rounded-md border bg-card p-4 transition-colors",
					isSelected && "border-primary/60 bg-primary/[0.05]",
				),
			),
		],
		[
			h.label(
				[h.Id(RadioGroup.labelId(radioInputId(options.value))), h.Class("flex cursor-pointer flex-col gap-2")],
				[
					h.span(
						[h.Class("flex items-center gap-2.5")],
						[
							...RadioGroup.radio(h, radioConfig, options.value),
							h.span([h.Class("text-sm font-medium text-foreground")], [options.title]),
							...(options.badge === undefined ? [] : [options.badge]),
						],
					),
					h.span([h.Class("pl-6.5 text-xs leading-relaxed text-muted-foreground")], [options.description]),
				],
			),
			...(isSelected && options.children !== undefined ? [h.div([h.Class("pl-6.5")], options.children)] : []),
		],
	)
}

const keyForm = (h: H, model: Model, isReplacing: boolean): Html => {
	const state = Field.stateOf(model.keyDraft, false)
	const ids = fieldIds("openrouter-api-key")
	return h.form(
		[h.Class("flex flex-col gap-3"), h.OnSubmit(Message.SubmittedKey())],
		[
			field(h, { state }, [
				fieldLabel(h, { ids, state }, isReplacing ? "New OpenRouter API key" : "OpenRouter API key"),
				input(h, {
					ids,
					state,
					attributes: [
						h.Type("password"),
						h.Attribute("autocomplete", "off"),
						h.Placeholder("sk-or-v1-..."),
						...(model.isSavingKey ? [h.Disabled(true)] : []),
						...Field.controlAttributes(h, model.keyDraft, (message) => Message.GotKeyDraftMessage({ message })),
					],
				}),
				fieldDescription(
					h,
					{ ids, state },
					"Create one at openrouter.ai/settings/keys. Maple checks it with OpenRouter, then stores it encrypted.",
				),
			]),
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					button(
						h,
						{ type: "submit", size: "sm", isLoading: model.isSavingKey, isDisabled: model.keyDraft.value.trim() === "" },
						[model.isSavingKey ? "Checking..." : "Save key"],
					),
					...(isReplacing
						? [
								button(
									h,
									{ variant: "ghost", size: "sm", isDisabled: model.isSavingKey, attributes: [h.OnClick(Message.ClickedCancelReplace())] },
									["Cancel"],
								),
							]
						: []),
				],
			),
		],
	)
}

/** `AddOnUpsell`: a lapsed key's notice, the add-on's price and "Add to plan" behind a confirm. */
const addOnUpsell = (h: H, model: Model, current: OpenRouterKeyDocument): Html =>
	h.div(
		[h.Class("flex flex-col gap-3")],
		[
			...(current.configured
				? [
						h.div(
							[h.Class("flex items-center justify-between gap-2 rounded-md border bg-background py-1.5 pr-1.5 pl-2.5")],
							[
								h.p(
									[h.Class("text-xs leading-relaxed text-muted-foreground")],
									["Your saved key (sk-or-...", current.keyHint ?? "", ") is not in use because the add-on has lapsed."],
								),
								button(
									h,
									{
										variant: "ghost",
										size: "sm",
										className: "shrink-0 text-destructive-foreground",
										isDisabled: model.isRemoving,
										attributes: [h.OnClick(Message.ClickedRemoveKey())],
									},
									["Remove"],
								),
							],
						),
					]
				: []),
			h.p(
				[h.Class("text-xs leading-relaxed text-muted-foreground")],
				["Needs the OpenRouter add-on, ", ADD_ON_PRICE, ", billed with your plan. Cancel any time from billing."],
			),
			button(
				h,
				{ size: "sm", className: "w-fit", isDisabled: model.isAttachingAddOn, attributes: [h.OnClick(Message.ClickedAddOn())] },
				["Add to plan"],
			),
			confirmDialog(h, {
				slotId: "openrouter-add-on-dialog",
				model: model.addOnDialog,
				toParentMessage: (message) => Message.GotAddOnDialogMessage({ message }),
				tone: "default",
				title: `Add the OpenRouter add-on for ${ADD_ON_PRICE}?`,
				description:
					"If your organization has a payment method on file, the add-on is attached right away and billed with your plan. Otherwise you continue to checkout.",
				confirmLabel: "Add to plan",
				onConfirm: Message.ClickedConfirmAddOn(),
				isPending: model.isAttachingAddOn,
			}),
		],
	)

const keyPanel = (h: H, model: Model, current: OpenRouterKeyDocument): ReadonlyArray<Html> => {
	if (!current.entitled) return [addOnUpsell(h, model, current)]
	if (current.configured && !model.isReplacing)
		return [
			h.div(
				[h.Class("flex items-center justify-between gap-2 rounded-md border bg-background py-1.5 pr-1.5 pl-2.5")],
				[
					h.code([h.Class("truncate font-mono text-sm")], ["sk-or-...", current.keyHint ?? ""]),
					h.div(
						[h.Class("flex shrink-0 items-center gap-1")],
						[
							button(
								h,
								{ variant: "outline", size: "sm", isDisabled: model.isRemoving, attributes: [h.OnClick(Message.ClickedReplace())] },
								["Replace"],
							),
							button(
								h,
								{
									variant: "ghost",
									size: "sm",
									className: "text-destructive-foreground",
									isDisabled: model.isRemoving,
									attributes: [h.OnClick(Message.ClickedRemoveKey())],
								},
								["Remove"],
							),
						],
					),
				],
			),
		]
	return [keyForm(h, model, current.configured)]
}

const providerChoice = (h: H, model: Model, current: OpenRouterKeyDocument): ReadonlyArray<Html> => {
	const isInUse = current.entitled && current.configured
	const selected: Provider = model.picked ?? (isInUse ? "openrouter" : "managed")
	return [
		RadioGroup.radioGroup(h, { label: "Model provider", className: "grid gap-3 sm:grid-cols-2" }, [
			providerCard(h, {
				value: "managed",
				selected,
				title: "Maple managed",
				description: "No setup. AI usage is billed on your plan.",
			}),
			providerCard(h, {
				value: "openrouter",
				selected,
				title: "Your OpenRouter key",
				badge: isInUse ? badge(h, { variant: "ok" }, ["In use"]) : undefined,
				description: "OpenRouter bills the tokens. Maple stops charging for AI usage.",
				children: keyPanel(h, model, current),
			}),
		]),
		confirmDialog(h, {
			slotId: "openrouter-remove-dialog",
			model: model.removeDialog,
			toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
			title: "Remove your OpenRouter key?",
			description: "Maple managed models take over, and AI usage is billed on your plan again.",
			confirmLabel: "Remove key",
			onConfirm: Message.ClickedConfirmRemove(),
			isPending: model.isRemoving,
		}),
	]
}

const providerSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "ai-provider-heading",
			title: "Model provider",
			description: ["Runs chat, investigations and pull request reviews. Models stay the same either way."],
			framed: false,
		},
		AsyncData.matchData(model.key, {
			onEmpty: () => [skeleton(h, "h-28 w-full")],
			onFailure: (failure) => [
				errorState(h, { failure, title: "Failed to load the model provider", variant: "row", onRetry: Message.ClickedRetryKey() }),
			],
			onData: (current) => providerChoice(h, model, current),
		}),
	)

// AUTO-TRIAGE

const limitRow = (
	h: H,
	options: Readonly<{
		id: string
		label: string
		help: string
		value: string
		error: string | null
		limit: number
		spent: number
		isDisabled: boolean
		onInput: (value: string) => Message
	}>,
): Html => {
	const state: FieldState = { ...IDLE, isInvalid: options.error !== null, isFilled: options.value !== "" }
	const ids = fieldIds(options.id)
	return field(h, { className: "flex-row items-start justify-between gap-6 p-4", state }, [
		h.div(
			[h.Class("flex min-w-0 flex-col gap-0.5")],
			[fieldLabel(h, { ids, state }, options.label), fieldDescription(h, { ids, state, className: "max-w-sm leading-relaxed" }, options.help)],
		),
		h.div(
			[h.Class("flex w-48 shrink-0 flex-col gap-2")],
			[
				input(h, {
					ids,
					state,
					attributes: [
						h.Attribute("inputmode", "numeric"),
						// `aria-invalid={error !== null}` renders "false" too, which the input chrome keys on.
						...(options.error === null ? [h.AriaInvalid(false)] : []),
						h.Value(options.value),
						...(options.isDisabled ? [h.Disabled(true)] : []),
						h.OnInput(options.onInput),
					],
				}),
				...(options.error === null
					? [
							meter(h, { value: options.spent, max: options.limit, label: `${options.label} used today` }),
							h.span([h.Class("font-mono text-2xs text-muted-foreground")], [formatNumber(options.spent), " used today"]),
						]
					: [fieldError(h, { ids, state }, options.error)]),
			],
		),
	])
}

const switchRow = (h: H, options: Readonly<{ id: string; label: string; description: string; isChecked: boolean; isDisabled?: boolean; onToggle?: Message; className: string }>): Html =>
	settingRow(h, {
		ids: { control: `${options.id}-input`, label: `${options.id}-label`, description: `${options.id}-description` },
		label: options.label,
		description: options.description,
		className: options.className,
		filled: options.isChecked,
		disabled: options.isDisabled,
		control: switchControl(h, {
			id: options.id,
			inputId: `${options.id}-input`,
			isChecked: options.isChecked,
			isDisabled: options.isDisabled,
			labelledBy: `${options.id}-label`,
			describedBy: `${options.id}-description`,
			isFilled: options.isChecked,
			onToggle: options.onToggle,
		}),
	})

const triageForm = (h: H, model: Model, current: AiTriageSettingsDocument): ReadonlyArray<Html> => {
	const draft = limitsDraftOf(model)
	const runs = parseDailyLimit(draft.maxRunsPerDay, RUNS_PER_DAY_LIMITS)
	const passes = parseDailyLimit(draft.maxPassesPerDay, PASSES_PER_DAY_LIMITS)
	// `Collapsible defaultOpen={!passesError.ok}`: an invalid ceiling keeps the section open.
	const isAdvancedOpen = model.isAdvancedOpen || !passes.ok
	return [
		panel(h, { className: "divide-y" }, [
			switchRow(h, {
				id: "ai-triage-enabled",
				label: "Investigate new incidents",
				description: "Applies right away.",
				isChecked: current.enabled,
				isDisabled: model.isToggling,
				onToggle: Message.ToggledTriage(),
				className: "p-4",
			}),
			limitRow(h, {
				id: "ai-triage-max-runs",
				label: "Investigations per day",
				help: "Per UTC day. Investigations you start or retry yourself are never blocked.",
				value: draft.maxRunsPerDay,
				error: runs.ok ? null : runs.message,
				limit: current.maxRunsPerDay,
				spent: current.usage.runs,
				isDisabled: model.isSavingLimits,
				onInput: (value) => Message.ChangedLimit({ field: "maxRunsPerDay", value }),
			}),
			h.div(
				[h.DataAttribute(isAdvancedOpen ? "open" : "closed", ""), h.DataAttribute("slot", "collapsible")],
				[
					h.button(
						[
							...(isAdvancedOpen ? [h.AriaControls("ai-triage-advanced")] : []),
							h.AriaDisabled(false),
							h.AriaExpanded(isAdvancedOpen),
							h.Class("group flex w-full items-center gap-2 px-4 py-3 text-left"),
							...(isAdvancedOpen ? [h.DataAttribute("panel-open", "")] : []),
							h.DataAttribute("slot", "collapsible-trigger"),
							h.Tabindex(0),
							h.Type("button"),
							h.OnClick(Message.ToggledAdvanced()),
						],
						[
							icon(h, "ChevronRightIcon", {
								size: 14,
								className: "shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90",
							}),
							h.span([h.Class("text-xs font-medium text-foreground")], ["Advanced limits"]),
							h.span(
								[h.Class("truncate text-2xs text-muted-foreground")],
								["Model passes per day, reserve for high and critical incidents"],
							),
						],
					),
					...(isAdvancedOpen
						? [
								h.div(
									[
										h.Class(collapsiblePanelStyles),
										h.DataAttribute("open", ""),
										h.DataAttribute("slot", "collapsible-panel"),
										h.Id("ai-triage-advanced"),
										h.Style({ "--collapsible-panel-height": "auto", "--collapsible-panel-width": "auto", "animation-name": "none" }),
									],
									[
										h.div(
											[],
											[
												limitRow(h, {
													id: "ai-triage-max-passes",
													label: "Model passes per day",
													help: "The spend ceiling. An investigation is one model pass. Three tenths of it is reserved for high and critical incidents.",
													value: draft.maxPassesPerDay,
													error: passes.ok ? null : passes.message,
													limit: current.maxPassesPerDay,
													spent: current.usage.passes,
													isDisabled: model.isSavingLimits,
													onInput: (value) => Message.ChangedLimit({ field: "maxPassesPerDay", value }),
												}),
											],
										),
									],
								),
							]
						: []),
				],
			),
		]),
		...saveBar(h, {
			isDirty: isLimitsDirty(model),
			isPending: model.isSavingLimits,
			onDiscard: Message.ClickedDiscardLimits(),
			onSave: Message.ClickedSaveLimits(),
			isSaveDisabled: !limitsUpdate(draft, current).ok,
		}),
	]
}

const triageTeaser = (h: H): Html =>
	settingsSection(
		h,
		{
			id: "ai-triage-heading",
			title: "Auto-triage",
			description: [TRIAGE_DESCRIPTION],
			actions: badge(h, { variant: "muted" }, ["Coming soon"]),
			framed: false,
		},
		[
			panel(h, { className: "divide-y" }, [
				switchRow(h, {
					id: "ai-triage-teaser-enabled",
					label: "Investigate new incidents",
					description: "Not yet available for your organization.",
					isChecked: false,
					isDisabled: true,
					className: "p-4 opacity-60",
				}),
				settingRow(h, {
					ids: { control: "ai-triage-teaser-runs", label: "ai-triage-teaser-runs-label", description: "ai-triage-teaser-runs-description" },
					label: "Investigations per day",
					description: "Per UTC day. Investigations you start or retry yourself are never blocked.",
					className: "p-4 opacity-60",
					control: [
						plainInput(h, {
							id: "ai-triage-teaser-runs",
							className: "w-48",
							isDisabled: true,
							attributes: [h.Value(""), h.Readonly(true), h.AriaLabel("Investigations per day")],
						}),
					],
				}),
			]),
		],
	)

const triageSection = (h: H, model: Model): Html =>
	model.isTriageAvailable
		? settingsSection(
				h,
				{ id: "ai-triage-heading", title: "Auto-triage", description: [TRIAGE_DESCRIPTION], framed: false },
				AsyncData.matchData(model.triage, {
					onEmpty: () => [skeleton(h, "h-40 w-full")],
					onFailure: (failure) => [
						errorState(h, { failure, title: "Failed to load auto-triage settings", variant: "row", onRetry: Message.ClickedRetryTriage() }),
					],
					onData: (current) => triageForm(h, model, current),
				}),
			)
		: triageTeaser(h)

const escalationCard = (h: H): Html =>
	h.div(
		[h.Class("flex items-start justify-between gap-4 rounded-md border border-dashed p-4")],
		[
			h.div(
				[h.Class("flex min-w-0 gap-3")],
				[
					icon(h, "BellIcon", { size: 16, className: "mt-0.5 shrink-0 text-muted-foreground" }),
					h.div(
						[h.Class("flex min-w-0 flex-col gap-0.5")],
						[
							h.span([h.Class("text-sm font-medium text-foreground")], ["Escalation routing"]),
							h.span(
								[h.Class("text-xs leading-relaxed text-muted-foreground")],
								["Route triaged issues by severity and confidence to your alert destinations."],
							),
						],
					),
				],
			),
			h.a(
				[
					h.Href("/settings?tab=automation"),
					h.Class(cn(buttonVariants({ variant: "outline", size: "sm", className: "shrink-0" }))),
					h.DataAttribute("slot", "button"),
				],
				["Open automation"],
			),
		],
	)

type NoInputs = Readonly<{ readonly none?: never }>

export const view = Submodel.defineView<Model, Message, NoInputs>((model, _inputs, h) =>
	settingsSections(h, "standard", [providerSection(h, model), triageSection(h, model), escalationCard(h)]),
)
