import { VercelDiscoverRequest, type VercelIntegrationStatus, type VercelTeam } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option, Schema } from "effect"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { draftProblem, samplingLabel, VERCEL_SAMPLING_RATES } from "../../components/integrations/vercel-model"
import { alert, alertDescription, alertTitle } from "../../ui/alert"
import { button } from "../../ui/button"
import * as Checkbox from "../../ui/checkbox"
import { confirmDialog } from "../../ui/confirm-dialog"
import * as DialogView from "../../ui/dialog-view"
import { badge } from "../../ui/display"
import * as Field from "../../ui/field"
import { icon } from "../../ui/icon"
import { input } from "../../ui/input"
import { nativeOption, nativeSelect } from "../../ui/native-select"
import * as RadioGroup from "../../ui/radio-group"
import { searchInput } from "../../ui/search-input"
import { segmentedSelect } from "../../ui/segmented-select"
import { switchControl } from "../../ui/switch"
import { Message } from "./message"
import type { Model } from "./model"
import { settingsChange, vercelStatusOf } from "./update-vercel"
import { VERCEL_CONFIGURE_DIALOG_ID, VERCEL_TOKENS_URL } from "./vercel"
import type { VercelConfigureModel, VercelPickableProject } from "./vercel-schema"
import { externalLink, footerNote } from "./view-gcp-configure-parts"
import { SMALL } from "./view-gcp-parts"

// `VercelConfigure`: the one place the connection is configured (connect, its settings, a new token),
// as steps in one dialog. Every primary button says what it does on Vercel, and when.

type H = HtmlBuilder<Message>
type Close = ReadonlyArray<ChildAttribute>

const TITLE = "text-sm/5 font-medium"
const decodeToken = Schema.decodeUnknownOption(VercelDiscoverRequest)

const header = (h: H, title: string): Html =>
	DialogView.dialogHeader(h, "dialog", [
		DialogView.dialogTitle(
			h,
			"dialog",
			VERCEL_CONFIGURE_DIALOG_ID,
			[
				h.span(
					[h.Class("flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/60")],
					[icon(h, "VercelIcon", { size: 16, className: "text-foreground" })],
				),
				h.span([h.Class("min-w-0")], [title]),
			],
			"flex items-center gap-3 pr-8 text-lg",
		),
	])

const body = (h: H, children: ReadonlyArray<Html>): Html =>
	DialogView.dialogPanel(h, "dialog", VERCEL_CONFIGURE_DIALOG_ID, children, "flex flex-col gap-5")

const footer = (h: H, children: ReadonlyArray<Html>): Html => DialogView.dialogFooter(h, "dialog", children)

const cancel = (h: H, configure: VercelConfigureModel, close: Close): Html => {
	const busy = configure.isLookingUp || configure.isSaving
	return button(
		h,
		{ variant: "outline", isDisabled: busy, slot: "dialog-close", attributes: busy ? [] : close },
		["Cancel"],
	)
}

const back = (h: H, configure: VercelConfigureModel): Html =>
	button(
		h,
		{
			variant: "outline",
			isDisabled: configure.isLookingUp || configure.isSaving,
			attributes: [h.OnClick(Message.ClickedVercelConfigureBack())],
		},
		["Back"],
	)

const refusal = (h: H, title: string, error: string | null): ReadonlyArray<Html> =>
	error === null
		? []
		: [
				alert(h, { size: "sm", variant: "crit" }, [
					icon(h, "AlertWarningIcon", { size: 14 }),
					alertTitle(h, [title]),
					alertDescription(h, [error], "[overflow-wrap:anywhere]"),
				]),
			]

// TOKEN

const TOKEN_IDS: Field.FieldIds = { control: "vercel-token", label: "vercel-token-label", error: "vercel-token-error" }

/** The token field with how to make a good one. */
const tokenFields = (h: H, configure: VercelConfigureModel): Html => {
	const trimmed = configure.token.value.trim()
	const tooShort = trimmed.length > 0 && Option.isNone(decodeToken({ token: trimmed }))
	const hasError = configure.error !== null
	const ids: Field.FieldIds =
		tooShort && !hasError ? { ...TOKEN_IDS, description: "vercel-token-description" } : TOKEN_IDS
	const state = Field.stateOf(configure.token, hasError || tooShort)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			Field.field(h, { className: "items-stretch gap-2", state }, [
				Field.fieldLabel(h, { ids, state }, "Vercel access token"),
				input(h, {
					id: ids.control,
					type: "password",
					fieldState: state,
					attributes: [
						h.Autocomplete("off"),
						h.Spellcheck(false),
						h.Placeholder("Paste a token"),
						...Field.controlAttributes(h, configure.token, (message) =>
							Message.GotVercelTokenMessage({ message }),
						),
						h.AriaLabelledBy(ids.label),
						...(hasError ? [h.AriaInvalid(true)] : []),
					],
				}),
				...(configure.error !== null
					? [
							Field.fieldError(
								h,
								{ ids, state, className: "leading-5 text-pretty", attributes: [h.Role("alert")] },
								configure.error,
							),
						]
					: tooShort
						? [Field.fieldDescription(h, { ids, state }, "A Vercel token is between 8 and 512 characters.")]
						: []),
			]),
			h.div(
				[h.Class("flex flex-col gap-2 rounded-lg border p-3")],
				[
					h.span([h.Class(TITLE)], ["Create one in ", externalLink(h, VERCEL_TOKENS_URL, "Vercel account settings")]),
					h.dl(
						[h.Class("grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs/5")],
						[
							h.dt([h.Class("text-foreground")], ["Scope"]),
							h.dd([h.Class("text-muted-foreground")], ["The team to monitor, not your whole account"]),
							h.dt([h.Class("text-foreground")], ["Expiration"]),
							h.dd([h.Class("text-muted-foreground")], ["Set one. Maple asks for a new token when it ends."]),
							h.dt([h.Class("text-foreground")], ["Plan"]),
							h.dd([h.Class("text-muted-foreground")], ["Drains need Vercel Pro or Enterprise"]),
						],
					),
				],
			),
		],
	)
}

const FORM_ID = "vercel-token-form"

const tokenStage = (
	h: H,
	configure: VercelConfigureModel,
	close: Close,
	copy: Readonly<{ title: string; note: string; submit: string }>,
): ReadonlyArray<Html> => [
	header(h, copy.title),
	body(h, [h.form([h.Id(FORM_ID), h.OnSubmit(Message.SubmittedVercelToken())], [tokenFields(h, configure)])]),
	footer(h, [
		footerNote(h, [copy.note]),
		cancel(h, configure, close),
		button(
			h,
			{
				type: "submit",
				isDisabled: Option.isNone(decodeToken({ token: configure.token.value })),
				isLoading: configure.isLookingUp || configure.isSaving,
				attributes: [h.Attribute("form", FORM_ID)],
			},
			[copy.submit],
		),
	]),
]

// TEAM

const teamStage = (h: H, configure: VercelConfigureModel, teams: ReadonlyArray<VercelTeam>): ReadonlyArray<Html> => {
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: configure.team,
		toParentMessage: (message) => Message.GotVercelTeamMessage({ message }),
		items: teams.map((team) => ({
			value: team.id,
			id: `vercel-team-${team.id}`,
			inputId: `vercel-team-${team.id}-input`,
		})),
	}
	return [
		header(h, "Connect Vercel"),
		body(h, [
			h.div(
				[h.Class("flex flex-col gap-2")],
				[
					h.h3([h.Id("vercel-team-heading"), h.Class(TITLE)], ["Which team should Maple watch?"]),
					RadioGroup.radioGroup(
						h,
						{ className: "gap-0 divide-y divide-border overflow-hidden rounded-md border" },
						teams.map((team) =>
							h.div(
								[h.Key(team.id), h.Class("flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40")],
								[
									...RadioGroup.radio(h, config, team.id),
									h.label(
										[
											h.Id(RadioGroup.labelId(`vercel-team-${team.id}-input`)),
											h.For(`vercel-team-${team.id}-input`),
											h.Class("flex min-w-0 flex-1 cursor-pointer items-center gap-3"),
										],
										[
											h.span([h.Class("min-w-0 flex-1 truncate text-sm font-medium")], [team.name]),
											h.span([h.Class("font-mono text-xs text-muted-foreground")], [team.slug]),
										],
									),
								],
							),
						),
					),
					h.p([h.Class(SMALL)], ["One team per Maple organization. Drains are created on the team you pick."]),
				],
			),
			...refusal(h, "Vercel didn't list the team's projects", configure.error),
		]),
		footer(h, [
			footerNote(h, ["Nothing changes on Vercel until you connect."]),
			back(h, configure),
			button(
				h,
				{
					isDisabled: Option.isNone(configure.team.maybeValue),
					isLoading: configure.isLookingUp,
					attributes: [h.OnClick(Message.SubmittedVercelTeam())],
				},
				["Continue"],
			),
		]),
	]
}

// SETTINGS

const SIGNALS = [
	{
		flag: "logsEnabled",
		title: "Logs",
		drain: "Maple logs",
		description: "Requests, functions, edge middleware and builds, with status, path and cache result.",
	},
	{
		flag: "tracesEnabled",
		title: "Traces",
		drain: "Maple traces",
		description: "Deployment traces, and every AI Gateway request with its model, tokens and cost.",
	},
] as const

const projectList = (h: H, configure: VercelConfigureModel, projects: ReadonlyArray<VercelPickableProject>): Html => {
	const query = configure.projectQuery.trim().toLowerCase()
	const shown = projects.filter((project) => query === "" || project.name.toLowerCase().includes(query))
	return h.div(
		[h.Class("flex flex-col overflow-hidden rounded-md border")],
		[
			...(projects.length > 8
				? [
						h.div(
							[h.Class("border-b p-2")],
							[
								searchInput(h, {
									id: "vercel-project-search",
									value: configure.projectQuery,
									placeholder: "Search projects…",
									onInput: (value) => Message.ChangedVercelProjectQuery({ value }),
									onClear: Message.ChangedVercelProjectQuery({ value: "" }),
								}),
							],
						),
					]
				: []),
			h.ul(
				[h.Class("max-h-56 divide-y divide-border/60 overflow-y-auto")],
				shown.length === 0
					? [
							h.li(
								[h.Class(cn(SMALL, "px-3 py-2"))],
								[projects.length === 0 ? "This team has no projects yet." : "No project matches."],
							),
						]
					: shown.map((project) => {
							const inputId = `vercel-project-${project.id}`
							return h.li(
								[h.Key(project.id)],
								[
									h.label(
										[
											h.Id(Checkbox.labelId(inputId)),
											h.Class("flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40"),
										],
										[
											...Checkbox.view(h, {
												model: { isChecked: configure.draft.projectIds.includes(project.id) },
												toParentMessage: () => Message.ToggledVercelProject({ id: project.id }),
												id: `${inputId}-root`,
												inputId,
											}),
											h.span([h.Class("min-w-0 flex-1 truncate text-sm")], [project.name]),
											...(project.framework === null
												? []
												: [badge(h, { variant: "meta", size: "xs" }, [project.framework])]),
										],
									),
								],
							)
						}),
			),
			h.p(
				[h.Class(cn(SMALL, "border-t bg-muted/30 px-3 py-1.5"))],
				[`${configure.draft.projectIds.length} of ${countLabel(projects.length, "project")} picked`],
			),
		],
	)
}

/** What the drains forward. Shared by connecting and by Configure. */
const settingsFields = (h: H, configure: VercelConfigureModel, projects: ReadonlyArray<VercelPickableProject>): Html => {
	const draft = configure.draft
	return h.div(
		[h.Class("flex flex-col gap-5")],
		[
			h.fieldset(
				[h.Class("flex flex-col gap-2")],
				[
					h.legend([h.Class(cn(TITLE, "mb-2"))], ["What should Vercel send?"]),
					h.div(
						[h.Class("divide-y divide-border/60 rounded-lg border")],
						SIGNALS.map((signal) =>
							h.div(
								[h.Key(signal.flag), h.Class("flex items-start gap-4 p-3")],
								[
									h.div(
										[h.Class("flex min-w-0 flex-1 flex-col gap-0.5")],
										[
											h.label(
												[
													h.Id(`vercel-${signal.flag}-label`),
													h.For(`vercel-${signal.flag}-input`),
													h.Class("flex items-center gap-2 text-sm font-medium"),
												],
												[
													signal.title,
													badge(h, { variant: "outline", size: "xs", className: "font-mono" }, [signal.drain]),
												],
											),
											h.p([h.Class(SMALL)], [signal.description]),
										],
									),
									...switchControl(h, {
										id: `vercel-${signal.flag}`,
										inputId: `vercel-${signal.flag}-input`,
										isChecked: draft[signal.flag],
										labelledBy: `vercel-${signal.flag}-label`,
										onToggle: Message.ToggledVercelSignal({ signal: signal.flag }),
									}),
								],
							),
						),
					),
				],
			),
			h.div(
				[h.Class("flex flex-col gap-2")],
				[
					h.div(
						[h.Class("flex items-center justify-between gap-3")],
						[
							h.h3([h.Class(TITLE)], ["Projects"]),
							segmentedSelect(h, {
								ariaLabel: "Projects",
								size: "sm",
								value: draft.projectScope,
								options: [
									{ value: "all", label: "All projects" },
									{ value: "some", label: "Pick projects" },
								],
								onChange: (scope) => Message.ChangedVercelScope({ scope }),
							}),
						],
					),
					draft.projectScope === "all"
						? h.p(
								[h.Class(SMALL)],
								[
									projects.length === 0
										? "Every project on the team, including ones created later."
										: `All ${countLabel(projects.length, "project")}, and ones created later.`,
								],
							)
						: projectList(h, configure, projects),
				],
			),
			h.div(
				[h.Class("flex flex-col gap-2")],
				[
					h.div(
						[h.Class("flex items-center justify-between gap-3")],
						[
							h.label([h.For("vercel-sampling"), h.Class(TITLE)], ["Sampling"]),
							nativeSelect(
								h,
								{
									className: "w-44",
									defaultValue: String(draft.samplingRate),
									attributes: [
										h.Id("vercel-sampling"),
										h.OnChange((value) => Message.ChangedVercelSampling({ value })),
									],
								},
								VERCEL_SAMPLING_RATES.map((rate) => nativeOption(String(rate), samplingLabel(rate))),
							),
						],
					),
					h.p([h.Class(SMALL)], ["Vercel samples before it sends, so a lower rate also lowers its bill."]),
				],
			),
			vercelCostNote(h),
		],
	)
}

/** Vercel's drain pricing in three facts. */
export const vercelCostNote = <M>(h: HtmlBuilder<M>): Html =>
	alert(h, { size: "sm", variant: "info", role: "note" }, [
		icon(h, "CircleInfoIcon", { size: 14 }),
		alertTitle(h, ["Vercel bills drains on its side"]),
		alertDescription(h, [
			h.ul(
				[h.Class("flex flex-col gap-0.5 leading-5")],
				[
					h.li([], [h.span([h.Class("font-medium text-foreground")], ["$0.50 per GB"]), " of logs and traces sent"]),
					h.li([], [h.span([h.Class("font-medium text-foreground")], ["$0.05 per 1,000"]), " AI Gateway traces"]),
					h.li(
						[],
						[
							"Pro and Enterprise plans only. ",
							h.a(
								[
									h.Href("https://vercel.com/docs/drains"),
									h.Target("_blank"),
									h.Rel("noreferrer"),
									h.Class("underline underline-offset-2 hover:no-underline"),
								],
								["Pricing"],
							),
						],
					),
				],
			),
		]),
	])

/** Connect: what to send on the picked team, then the drains are created. */
const connectSettingsStage = (
	h: H,
	configure: VercelConfigureModel,
	team: VercelTeam,
	projects: ReadonlyArray<VercelPickableProject>,
): ReadonlyArray<Html> => {
	const draft = configure.draft
	const problem = draftProblem(draft)
	return [
		header(h, `Connect ${team.name}`),
		body(h, [settingsFields(h, configure, projects), ...refusal(h, "Vercel refused the drains", configure.error)]),
		footer(h, [
			footerNote(h, [
				problem ?? `Creates ${draft.logsEnabled && draft.tracesEnabled ? "2 drains" : "a drain"} on ${team.name} right away.`,
			]),
			back(h, configure),
			button(
				h,
				{
					isDisabled: problem !== null,
					isLoading: configure.isSaving,
					attributes: [h.OnClick(Message.SubmittedVercelConnect())],
				},
				["Connect"],
			),
		]),
	]
}

/** Configure: saving re-applies the drains on Vercel at once. */
const settingsStage = (
	h: H,
	configure: VercelConfigureModel,
	status: VercelIntegrationStatus,
	close: Close,
): ReadonlyArray<Html> => {
	const change = settingsChange(status, configure)
	return [
		header(h, `Configure ${status.team?.name ?? "Vercel"}`),
		body(h, [
			settingsFields(h, configure, configure.projects ?? []),
			...refusal(h, "Vercel refused the change", configure.error),
		]),
		footer(h, [
			footerNote(h, [change.problem ?? "Saving updates the drains on Vercel immediately."]),
			cancel(h, configure, close),
			button(
				h,
				{
					isDisabled: !change.isChanged || change.problem !== null,
					isLoading: configure.isSaving && !configure.confirm.isOpen,
					attributes: [h.OnClick(Message.ClickedVercelSave())],
				},
				["Save and apply"],
			),
		]),
	]
}

/** "Forward less from Vercel?": what saving stops, confirmed before it acts. */
const forwardLessConfirm = (h: H, configure: VercelConfigureModel, status: VercelIntegrationStatus): Html =>
	confirmDialog(h, {
		slotId: "vercel-configure-confirm",
		model: configure.confirm,
		toParentMessage: (message) => Message.GotVercelConfirmDialogMessage({ message }),
		isNested: true,
		title: "Forward less from Vercel?",
		description: "This takes effect on Vercel as soon as you confirm.",
		confirmLabel: "Apply",
		onConfirm: Message.ConfirmedVercelSave(),
		isPending: configure.isSaving,
		children: [
			h.ul(
				[h.Class("flex list-disc flex-col gap-1 pb-3 pl-5 text-sm")],
				settingsChange(status, configure).stops.map((stop) => h.li([h.Key(stop)], [stop])),
			),
		],
	})

const stages = (
	h: H,
	configure: VercelConfigureModel,
	status: VercelIntegrationStatus | null,
	close: Close,
): ReadonlyArray<Html> => {
	if (configure.target === "configure" && status !== null) return settingsStage(h, configure, status, close)
	if (configure.target === "token")
		return tokenStage(h, configure, close, {
			title: `New token for ${status?.team?.name ?? "Vercel"}`,
			note: `Maple checks it can see ${status?.team?.name ?? "the team"} and re-applies the drains.`,
			submit: "Save token",
		})
	const teamId = Option.getOrNull(configure.team.maybeValue)
	const team = configure.teams?.find((candidate) => candidate.id === teamId)
	if (configure.projects !== null && team !== undefined)
		return connectSettingsStage(h, configure, team, configure.projects)
	if (configure.teams !== null && configure.teams.length > 1) return teamStage(h, configure, configure.teams)
	return tokenStage(h, configure, close, {
		title: "Connect Vercel",
		note: "Maple lists the token's teams and projects. Nothing is created yet.",
		submit: "Continue",
	})
}

/** The dialog every step renders in, open while `configure` is; the confirmation sits beside it. */
export const vercelConfigure = (h: H, model: Model): ReadonlyArray<Html> => {
	const configure = model.vercelCard.configure
	if (configure === null) return []
	const status = vercelStatusOf(model)
	return [
		h.submodel({
			slotId: "vercel-configure",
			model: configure.dialog,
			view: DialogView.view,
			toParentMessage: (message) => Message.GotVercelConfigureDialogMessage({ message }),
			viewInputs: {
				hasTrigger: false,
				hasDescription: false,
				className: "sm:max-w-xl",
				nestedDialogs: configure.confirm.isOpen ? 1 : 0,
				toView: ({ portal }) => portal ?? h.empty,
				toContent: (close) => stages(h, configure, status, close),
			},
		}),
		...(configure.target === "configure" && status !== null ? [forwardLessConfirm(h, configure, status)] : []),
	]
}
