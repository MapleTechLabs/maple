import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { button } from "../../../ui/button"
import * as DialogView from "../../../ui/dialog-view"
import { emptyMessage } from "../../../ui/empty"
import { field, fieldDescription, type FieldIds, fieldLabel, input, type FieldState } from "../../../ui/field"
import * as Field from "../../../ui/field"
import { inlineCode } from "../../../ui/inline-code"
import { searchInput } from "../../../ui/search-input"
import { segmentedSelect } from "../../../ui/segmented-select"
import * as SelectView from "../../../ui/select-view"
import {
	type AccessMode,
	blockedReason,
	canCreate,
	EXPIRATION_OPTIONS,
	Message,
	type Model,
	SCOPE_FAMILIES,
	type ScopeLevel,
	selectedFamilyCount,
} from "./create-dialog"
import { secretReveal } from "./secret-reveal"

type H = HtmlBuilder<Message>

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}

const ids = (name: string, hasDescription = false): FieldIds => {
	const base = {
		control: `api-key-${name}`,
		label: `api-key-${name}-label`,
		error: `api-key-${name}-error`,
	}
	return hasDescription ? { ...base, description: `api-key-${name}-description` } : base
}

const LEVEL_OPTIONS: ReadonlyArray<{ readonly value: ScopeLevel; readonly label: string }> = [
	{ value: "none", label: "None" },
	{ value: "read", label: "Read" },
	{ value: "write", label: "Write" },
]

const textField = (
	h: H,
	options: Readonly<{
		name: string
		label: string | ReadonlyArray<Html | string>
		placeholder: string
		model: Field.Model
		toMessage: (message: Field.Message) => Message
		onKeyDown?: (key: string) => Message
	}>,
): Html => {
	const state = Field.stateOf(options.model, false)
	const fieldIds = ids(options.name)
	return field(h, { state }, [
		fieldLabel(h, { ids: fieldIds, state }, options.label),
		input(h, {
			ids: fieldIds,
			state,
			attributes: [
				h.Placeholder(options.placeholder),
				...Field.controlAttributes(h, options.model, options.toMessage),
				...(options.onKeyDown === undefined ? [] : [h.OnKeyDown(options.onKeyDown)]),
			],
		}),
	])
}

const expirationField = (h: H, model: Model): Html => {
	const state: FieldState = { ...IDLE, isFilled: true }
	const fieldIds = ids("expiration")
	return h.submodel({
		slotId: "api-key-expiration-select",
		model: model.expiration,
		view: SelectView.view,
		toParentMessage: (message) => Message.GotExpirationMessage({ message }),
		viewInputs: {
			entries: EXPIRATION_OPTIONS.map((item): SelectView.SelectEntry => ({ _tag: "Item", item })),
			className: "w-full",
			// The accessible name matches the field label.
			ariaLabel: "Expiration",
			renderValue: (value) => [
				EXPIRATION_OPTIONS.find((option) => option.value === value)?.label ?? value,
			],
			toView: (parts) =>
				field(h, { state }, [fieldLabel(h, { ids: fieldIds, state }, "Expiration"), ...parts]),
		},
	})
}

const scopeRows = (h: H, model: Model): ReadonlyArray<Html> => {
	const needle = model.scopeFilter.trim().toLowerCase()
	const visible = SCOPE_FAMILIES.filter(
		(family) => needle.length === 0 || family.label.toLowerCase().includes(needle),
	)
	return [
		...(visible.length === 0
			? [
					emptyMessage(h, { className: "py-2 text-left" }, [
						`No resource family matches "${model.scopeFilter.trim()}".`,
					]),
				]
			: []),
		...visible.map((family) =>
			h.div(
				[h.Key(family.id), h.Class("flex items-center justify-between gap-3")],
				[
					h.span([h.Class("text-foreground text-sm")], [family.label]),
					segmentedSelect(h, {
						ariaLabel: `${family.label} access`,
						value: model.scopeLevels[family.id] ?? "none",
						onChange: (level) => Message.ClickedScopeLevel({ family: family.id, level }),
						size: "sm",
						options: LEVEL_OPTIONS,
					}),
				],
			),
		),
	]
}

const accessField = (h: H, model: Model): Html => {
	const fieldIds = ids("access", true)
	const isRestricted = model.accessMode === "restricted"
	const count = selectedFamilyCount(model)
	return field(h, { state: IDLE }, [
		fieldLabel(h, { ids: fieldIds, state: IDLE }, "Access"),
		segmentedSelect<AccessMode, Message>(h, {
			ariaLabel: "Access",
			value: model.accessMode,
			onChange: (mode) => Message.ClickedAccessMode({ mode }),
			size: "sm",
			options: [
				{ value: "full", label: "Full access" },
				{ value: "restricted", label: "Restricted" },
			],
		}),
		isRestricted
			? h.div(
					[h.Class("space-y-2 pt-1")],
					[
						h.div(
							[h.Class("flex flex-wrap items-center gap-2")],
							[
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										attributes: [h.OnClick(Message.ClickedAllScopes({ level: "read" }))],
									},
									["All read"],
								),
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										attributes: [h.OnClick(Message.ClickedAllScopes({ level: "write" }))],
									},
									["All write"],
								),
								button(
									h,
									{
										variant: "ghost",
										size: "sm",
										isDisabled: count === 0,
										attributes: [h.OnClick(Message.ClickedClearScopes())],
									},
									["Clear"],
								),
								h.span(
									[h.Class("text-muted-foreground text-xs")],
									[String(count), " of ", String(SCOPE_FAMILIES.length), " selected"],
								),
							],
						),
						searchInput(h, {
							id: "api-key-scope-filter",
							value: model.scopeFilter,
							onInput: (value) => Message.ChangedScopeFilter({ value }),
							onClear: Message.ClickedClearScopeFilter(),
							placeholder: "Filter resource families",
						}),
						...scopeRows(h, model),
						fieldDescription(
							h,
							{ ids: fieldIds, state: IDLE },
							"Write includes read. Scopes are fixed at creation; roll the key to change access.",
						),
					],
				)
			: fieldDescription(h, { ids: fieldIds, state: IDLE }, "Full access to the organization's API."),
	])
}

const formContent = (h: H, model: Model): ReadonlyArray<Html> => {
	const isMcp = model.kind === "mcp"
	const reason = blockedReason(model)
	return [
		DialogView.dialogHeader(h, "dialog", [
			DialogView.dialogTitle(h, "dialog", model.dialog.id, isMcp ? "Create MCP key" : "Create API key"),
			DialogView.dialogDescription(
				h,
				"dialog",
				model.dialog.id,
				isMcp
					? "MCP keys authenticate clients with the Maple MCP server."
					: "API keys authenticate clients with the Maple API.",
			),
		]),
		DialogView.dialogPanel(
			h,
			"dialog",
			model.dialog.id,
			[
				textField(h, {
					name: "name",
					label: "Name",
					placeholder: "e.g. CI/CD Pipeline",
					model: model.name,
					toMessage: (message) => Message.GotNameMessage({ message }),
					onKeyDown: (key) => Message.PressedNameKey({ key }),
				}),
				textField(h, {
					name: "description",
					label: [
						"Description",
						" ",
						h.span([h.Class("text-muted-foreground font-normal")], ["(optional)"]),
					],
					placeholder: "What is this key used for?",
					model: model.description,
					toMessage: (message) => Message.GotDescriptionMessage({ message }),
				}),
				expirationField(h, model),
				...(isMcp ? [] : [accessField(h, model)]),
			],
			"space-y-4",
		),
		DialogView.dialogFooter(h, "dialog", [
			...(reason === null ? [] : [DialogView.dialogFooterHint(h, reason)]),
			button(h, { variant: "outline", attributes: [h.OnClick(Message.ClickedCancel())] }, ["Cancel"]),
			button(
				h,
				{
					isLoading: model.isCreating,
					isDisabled: !canCreate(model),
					attributes: [h.OnClick(Message.ClickedCreate())],
				},
				["Create"],
			),
		]),
	]
}

const createdContent = (h: H, model: Model): ReadonlyArray<Html> => {
	const created = model.created
	if (created === null) return []
	return [
		DialogView.dialogHeader(h, "dialog", [
			DialogView.dialogTitle(
				h,
				"dialog",
				model.dialog.id,
				model.kind === "mcp" ? "MCP key created" : "API key created",
			),
			DialogView.dialogDescription(
				h,
				"dialog",
				model.dialog.id,
				"Copy your API key now. You won't be able to see it again.",
			),
		]),
		DialogView.dialogPanel(
			h,
			"dialog",
			model.dialog.id,
			[
				h.div(
					[h.Class("flex flex-wrap items-center gap-1.5")],
					[
						h.span([h.Class("text-foreground text-sm font-medium")], [created.name]),
						inlineCode(h, { variant: "plain", className: "text-2xs tracking-tight" }, [
							created.key_prefix,
							"…",
						]),
						...(created.scopes ?? []).map((scope) =>
							badge(h, { variant: "outline", size: "sm", mono: true }, [scope]),
						),
					],
				),
				secretReveal(h, {
					id: "api-key-created-secret",
					secret: created.secret,
					copy: model.secretCopy,
					toCopyMessage: (message) => Message.GotSecretCopyMessage({ message }),
					isVisible: model.isSecretVisible,
					onToggle: Message.ToggledSecretVisible(),
				}),
			],
			"space-y-3",
		),
		DialogView.dialogFooter(h, "dialog", [
			button(h, { variant: "outline", attributes: [h.OnClick(Message.ClickedCancel())] }, ["Done"]),
		]),
	]
}

export const view = Submodel.defineView<Model, Message, Readonly<{ slotId: string }>>((model, inputs, h) =>
	h.submodel({
		slotId: inputs.slotId,
		model: model.dialog,
		view: DialogView.view,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		viewInputs: {
			hasTrigger: false,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: () => (model.created === null ? formContent(h, model) : createdContent(h, model)),
		},
	}),
)
