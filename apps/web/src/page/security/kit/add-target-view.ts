import type { GithubRepoSummary } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { linkButton } from "../../../ui/button"
import * as Checkbox from "../../../ui/checkbox"
import * as Field from "../../../ui/field"
import { formDialog } from "../../../ui/form-dialog"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { inputGroup, inputGroupAddon, inputGroupInput } from "../../../ui/input-group"
import * as RadioGroup from "../../../ui/radio-group"
import * as SelectView from "../../../ui/select-view"
import {
	DIALOG_ID,
	errorsOf,
	NO_ERRORS,
	fieldFailure,
	Message,
	type Model,
	MAX_SCOPE_PATHS,
} from "./add-target"
import { formatUsd } from "./format"
import { modelPicker } from "./model-picker"

// The Add audit target form inside the shared FormDialog.

type H = HtmlBuilder<Message>

const idsOf = (name: string, hasDescription = true): Field.FieldIds => {
	const ids = {
		control: `${DIALOG_ID}-${name}`,
		label: `${DIALOG_ID}-${name}-label`,
		error: `${DIALOG_ID}-${name}-error`,
	}
	return hasDescription ? { ...ids, description: `${DIALOG_ID}-${name}-description` } : ids
}

const PROFILES = [
	{
		value: "deep",
		label: "Deep",
		hint: "Recommended",
		description: "Waves repeat until two critics find no missed units. Takes hours.",
	},
	{
		value: "quick",
		label: "Quick",
		hint: null,
		description: "Fewer units, one hunting wave. A first look in under an hour.",
	},
] as const

const fieldShell = (
	h: H,
	options: Readonly<{
		name: string
		label: string | ReadonlyArray<Html | string>
		description?: string | ReadonlyArray<Html | string>
		error?: string
		isFilled: boolean
	}>,
	control: (ids: Field.FieldIds, state: ReturnType<typeof Field.stateOf>) => Html,
): Html => {
	const ids = idsOf(options.name, options.description !== undefined)
	const state = { ...Field.stateOf(Field.init(), options.error !== undefined), isFilled: options.isFilled }
	return Field.field(h, { state }, [
		Field.fieldLabel(h, { ids, state }, options.label),
		control(ids, state),
		...(options.description === undefined
			? []
			: [Field.fieldDescription(h, { ids, state }, options.description)]),
		...(options.error === undefined
			? []
			: [Field.fieldError(h, { ids, state, attributes: [h.Role("alert")] }, options.error)]),
	])
}

const optionalHint = (h: H, label: string): ReadonlyArray<Html | string> => [
	label,
	h.span([h.Class("ml-1.5 font-normal text-muted-foreground")], ["Optional"]),
]

const repositoryField = (
	h: H,
	model: Model,
	repositories: ReadonlyArray<GithubRepoSummary>,
	error?: string,
): Html => {
	const entries: ReadonlyArray<SelectView.SelectEntry> = repositories.map((repo) => ({
		_tag: "Item",
		item: { value: repo.fullName, label: repo.fullName },
	}))
	return fieldShell(
		h,
		{
			name: "repository",
			label: "Repository",
			description: [
				`From the ${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"} the Maple GitHub App can read. Missing one? `,
				h.a(
					[
						h.Href(hrefOf(AppRoute.Integrations({ search: {} }))),
						h.Class("underline underline-offset-2"),
					],
					["Manage access in GitHub"],
				),
				".",
			],
			error,
			isFilled: model.repository.value !== "",
		},
		(ids) =>
			h.submodel({
				slotId: model.repository.id,
				model: model.repository,
				view: SelectView.view,
				viewInputs: {
					entries,
					labelledBy: ids.label,
					describedBy: ids.description,
					className: "w-full",
					leading: [icon(h, "GithubIcon", { size: 14, className: "text-muted-foreground" })],
					renderValue: (value) => [
						value === ""
							? h.span([h.Class("text-muted-foreground")], ["Pick a repository"])
							: value,
					],
					toView: (parts) => h.div([h.Class("contents")], parts),
				},
				toParentMessage: (message) => Message.GotRepositoryMessage({ message }),
			}),
	)
}

const branchField = (h: H, model: Model, error?: string): Html =>
	fieldShell(h, { name: "branch", label: "Branch", error, isFilled: model.branch.value !== "" }, (ids) =>
		inputGroup(h, {}, [
			inputGroupAddon(h, {}, [icon(h, "BranchForkIcon", { size: 14 })]),
			inputGroupInput(h, {
				id: ids.control,
				attributes: [
					h.AriaLabelledBy(ids.label),
					...(error === undefined ? [] : [h.AriaInvalid(true), h.AriaDescribedBy(ids.error)]),
					h.Placeholder("main"),
					h.Attribute("autocomplete", "off"),
					h.Attribute("spellcheck", "false"),
					...Field.controlAttributes(h, model.branch, (message) =>
						Message.GotBranchMessage({ message }),
					),
				],
			}),
		]),
	)

const profileField = (h: H, model: Model): Html => {
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: model.profile,
		toParentMessage: (message) => Message.GotProfileMessage({ message }),
		items: PROFILES.map((profile) => ({
			value: profile.value,
			id: `${DIALOG_ID}-profile-${profile.value}`,
			inputId: `${DIALOG_ID}-profile-${profile.value}-input`,
		})),
	}
	return h.div(
		[h.Class("flex flex-col gap-2")],
		[
			h.span([h.Id(`${DIALOG_ID}-profile-label`), h.Class("text-sm font-medium")], ["Profile"]),
			RadioGroup.radioGroup(
				h,
				{ label: "Profile", className: "grid grid-cols-2 gap-2" },
				PROFILES.map((profile) => {
					const isChecked = Option.contains(model.profile.maybeValue, profile.value)
					return h.label(
						[
							h.Key(profile.value),
							h.Id(RadioGroup.labelId(`${DIALOG_ID}-profile-${profile.value}-input`)),
							h.Class(
								cn(
									"flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors",
									isChecked ? "border-foreground/40 bg-accent/50" : "hover:bg-accent/30",
								),
							),
						],
						[
							...RadioGroup.radio(h, config, profile.value, "mt-0.5"),
							h.span(
								[h.Class("flex min-w-0 flex-col gap-1")],
								[
									h.span(
										[h.Class("text-sm font-medium")],
										[
											profile.label,
											...(profile.hint === null
												? []
												: [
														h.span(
															[
																h.Class(
																	"ml-1.5 text-xs font-normal text-muted-foreground",
																),
															],
															[profile.hint],
														),
													]),
										],
									),
									h.span([h.Class("text-xs text-muted-foreground")], [profile.description]),
								],
							),
						],
					)
				}),
			),
		],
	)
}

const scopeChip = (h: H, path: string): Html =>
	h.span(
		[
			h.Key(path),
			h.Class(
				"inline-flex max-w-full items-center gap-1 rounded-sm bg-muted py-0.5 pr-0.5 pl-1.5 font-mono text-xs",
			),
		],
		[
			icon(h, "FolderIcon", { size: 12, className: "text-muted-foreground" }),
			h.span([h.Class("truncate")], [path]),
			iconButton(
				h,
				{
					label: `Remove ${path}`,
					size: "icon-2xs",
					className: "text-muted-foreground hover:text-foreground",
					attributes: [h.OnClick(Message.RemovedScopePath({ path }))],
				},
				[icon(h, "XmarkIcon", { size: 12 })],
			),
		],
	)

const scopeField = (h: H, model: Model, error?: string): Html =>
	fieldShell(
		h,
		{
			name: "scope",
			label: optionalHint(h, "Scope paths"),
			description:
				"Leave empty to audit the whole repository. Paths outside the scope are recorded as out of scope, never as covered.",
			error,
			isFilled: model.scopePaths.length > 0,
		},
		(ids) =>
			h.div(
				[h.Class("flex w-full flex-col gap-2")],
				[
					...(model.scopePaths.length === 0
						? []
						: [
								h.div(
									[h.Class("flex flex-wrap gap-1.5")],
									model.scopePaths.map((path) => scopeChip(h, path)),
								),
							]),
					Field.input(h, {
						ids,
						state: Field.stateOf(model.scopeDraft, error !== undefined),
						attributes: [
							h.Placeholder(
								model.scopePaths.length >= MAX_SCOPE_PATHS
									? "Scope is full"
									: "Add a path, then press Enter",
							),
							h.Attribute("autocomplete", "off"),
							h.Attribute("spellcheck", "false"),
							h.OnKeyDownPreventDefault((key) =>
								key === "Enter" ? Option.some(Message.AddedScopePath()) : Option.none(),
							),
							...Field.controlAttributes(h, model.scopeDraft, (message) =>
								Message.GotScopeMessage({ message }),
							),
						],
					}),
				],
			),
	)

/** The models the target runs on, the org's unless changed here, and what the org has left. */
const modelsField = (h: H, model: Model, error?: string): Html => {
	const settings = model.orgSettings
	const isOrgDefault =
		settings !== null &&
		model.discovery.value === settings.discoveryModel &&
		model.validation.value === settings.validationModel
	return h.div(
		[h.Class("flex flex-col gap-2")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-3")],
				[
					h.span([h.Class("text-sm font-medium")], ["Models"]),
					...(isOrgDefault
						? [h.span([h.Class("text-xs text-muted-foreground")], ["Using the org's defaults"])]
						: []),
				],
			),
			h.div(
				[h.Class("grid grid-cols-2 gap-2")],
				[
					modelPicker(h, {
						stage: "discovery",
						model: model.discovery,
						idPrefix: DIALOG_ID,
						wrap: (message) => Message.GotDiscoveryMessage({ message }),
					}),
					modelPicker(h, {
						stage: "validation",
						model: model.validation,
						idPrefix: DIALOG_ID,
						wrap: (message) => Message.GotValidationMessage({ message }),
					}),
				],
			),
			...(error === undefined
				? []
				: [h.p([h.Role("alert"), h.Class("text-xs text-destructive")], [error])]),
			...(settings === null
				? []
				: [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								`${formatUsd(Math.max(0, settings.monthlySpendLimitUsd - settings.spentUsd))} left of the org's ${formatUsd(settings.monthlySpendLimitUsd)} monthly limit. A run that reaches it stops and lists what it did not cover.`,
							],
						),
					]),
		],
	)
}

const startNowToggle = (h: H, model: Model): Html => {
	const inputId = `${DIALOG_ID}-start-now`
	return h.label(
		[h.Id(Checkbox.labelId(inputId)), h.Class("flex items-center gap-2 text-sm")],
		[
			...Checkbox.view(h, {
				model: { isChecked: model.startNow },
				toParentMessage: () => Message.ToggledStartNow(),
				id: `${inputId}-root`,
				inputId,
			}),
			"Start the first run now",
		],
	)
}

/** No installation or no readable repository: the form cannot work, so it points at GitHub. */
const notConnected = (h: H): Html =>
	alert(h, { variant: "info" }, [
		icon(h, "GithubIcon"),
		alertTitle(h, ["Connect GitHub first"]),
		alertDescription(h, [
			"Audits read code through the Maple GitHub App. Connect it and pick the repositories it may read.",
			linkButton(
				h,
				{ size: "sm", variant: "outline", href: hrefOf(AppRoute.Integrations({ search: {} })) },
				["Open integrations"],
			),
		]),
	])

const failureAlert = (h: H, model: Model): ReadonlyArray<Html> =>
	model.failure === null || fieldFailure(model.failure) !== null
		? []
		: [
				alert(h, { variant: "crit" }, [
					icon(h, "CircleWarningIcon"),
					alertTitle(h, [model.failure.title]),
					alertDescription(h, [model.failure.message]),
				]),
			]

const addTargetDialog = (
	h: HtmlBuilder<Message>,
	model: Model,
	repositories: ReadonlyArray<GithubRepoSummary>,
): Html => {
	const errors = model.isSubmitted ? errorsOf(model) : NO_ERRORS
	const server = fieldFailure(model.failure)
	const hasRepositories = repositories.length > 0
	return formDialog(h, {
		slotId: DIALOG_ID,
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		title: "Add audit target",
		description: "Pick a repository branch to audit. You can start a run as soon as it is added.",
		onSubmit: Message.Submitted(),
		submitLabel: "Add target",
		isPending: model.isPending,
		isSubmitDisabled: !hasRepositories,
		footerStart: hasRepositories ? startNowToggle(h, model) : undefined,
		panelClassName: "flex flex-col gap-5",
		fields: hasRepositories
			? [
					...failureAlert(h, model),
					repositoryField(
						h,
						model,
						repositories,
						errors.repository ?? (server?.field === "repository" ? server.message : undefined),
					),
					branchField(
						h,
						model,
						errors.branch ?? (server?.field === "branch" ? server.message : undefined),
					),
					profileField(h, model),
					scopeField(
						h,
						model,
						errors.scope ?? (server?.field === "scope" ? server.message : undefined),
					),
					modelsField(
						h,
						model,
						errors.models ?? (server?.field === "models" ? server.message : undefined),
					),
				]
			: [notConnected(h)],
	})
}

/** The dialog as a Submodel view, so a page embeds it with its own Message wrapper. */
export const addTargetView = Submodel.defineView<
	Model,
	Message,
	/** The installation's active repositories; none means GitHub is not connected yet. */
	Readonly<{ repositories: ReadonlyArray<GithubRepoSummary> }>
>((model, inputs, h) => addTargetDialog(h, model, inputs.repositories))
