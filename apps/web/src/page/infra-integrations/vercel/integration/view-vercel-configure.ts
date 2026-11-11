import { VercelDiscoverRequest, type VercelIntegrationStatus, type VercelTeam } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { draftProblem, samplingLabel, VERCEL_SAMPLING_RATES } from "./vercel-model"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import * as Checkbox from "@maple/views/ui/checkbox"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import * as Field from "@maple/views/ui/field"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { input } from "@maple/views/ui/input"
import { label } from "@maple/views/ui/label"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import * as RadioGroup from "@maple/views/ui/radio-group"
import { dividedList } from "@maple/views/ui/rule"
import { searchInput } from "@maple/views/ui/search-input"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { hstack, vstack } from "@maple/views/ui/stack"
import { switchControl } from "@maple/views/ui/switch"
import { typography } from "@maple/views/ui/typography"
import { Message } from "../../../integrations/message"
import type { Model } from "../../../integrations/model"
import { settingsChange, vercelStatusOf } from "./update-vercel"
import { VERCEL_CONFIGURE_DIALOG_ID, VERCEL_TOKENS_URL } from "./vercel"
import type { VercelConfigureModel, VercelPickableProject } from "./vercel-schema"
import { externalLink, footerNote } from "../../gcp/integration/view-gcp-configure-parts"
import { SMALL } from "../../gcp/integration/view-gcp-parts"

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
				hstack(
					h,
					{
						as: "span",
						justify: "center",
						className: "size-8 shrink-0 rounded-md border bg-surface-strong",
					},
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

/** Vercel reports the team on Hobby, where it refuses drains. */
const onHobby = (team: VercelTeam): boolean => team.plan === "hobby"

const hobbyWarning = (h: H, team: VercelTeam): ReadonlyArray<Html> =>
	onHobby(team)
		? [
				alert(h, { size: "sm", variant: "warn" }, [
					icon(h, "AlertWarningIcon", { size: 14 }),
					alertTitle(h, [`${team.name} is on Vercel's Hobby plan`]),
					alertDescription(h, [
						"Vercel creates drains only on Pro and Enterprise teams, so connecting fails until you upgrade the team in Vercel.",
					]),
				]),
			]
		: []

// TOKEN

const TOKEN_IDS: Field.FieldIds = {
	control: "vercel-token",
	label: "vercel-token-label",
	error: "vercel-token-error",
}

/** The token field with how to make a good one. */
const tokenFields = (h: H, configure: VercelConfigureModel): Html => {
	const trimmed = Str.trim(configure.token.value)
	const tooShort = trimmed.length > 0 && Option.isNone(decodeToken({ token: trimmed }))
	const hasError = configure.error !== null
	const ids: Field.FieldIds =
		tooShort && !hasError ? { ...TOKEN_IDS, description: "vercel-token-description" } : TOKEN_IDS
	const state = Field.stateOf(configure.token, hasError || tooShort)
	return vstack(h, { gap: "4" }, [
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
							{ ids, state, className: "text-xs/5 text-pretty", attributes: [h.Role("alert")] },
							configure.error,
						),
					]
				: tooShort
					? [
							Field.fieldDescription(
								h,
								{ ids, state },
								"A Vercel token is between 8 and 512 characters.",
							),
						]
					: []),
		]),
		vstack(h, { gap: "2", className: "rounded-lg border p-3" }, [
			h.span(
				[h.Class(TITLE)],
				["Create one in ", externalLink(h, VERCEL_TOKENS_URL, "Vercel account settings")],
			),
			h.dl(
				[h.Class("grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs/5")],
				[
					h.dt([h.Class("text-foreground")], ["Scope"]),
					h.dd([h.Class("text-muted-foreground")], ["The team to monitor, not your whole account"]),
					h.dt([h.Class("text-foreground")], ["Expiration"]),
					h.dd(
						[h.Class("text-muted-foreground")],
						["Set one. Maple asks for a new token when it ends."],
					),
					h.dt([h.Class("text-foreground")], ["Plan"]),
					h.dd([h.Class("text-muted-foreground")], ["Drains need Vercel Pro or Enterprise"]),
				],
			),
		]),
	])
}

const FORM_ID = "vercel-token-form"

const tokenStage = (
	h: H,
	configure: VercelConfigureModel,
	close: Close,
	copy: Readonly<{ title: string; note: string; submit: string }>,
): ReadonlyArray<Html> => [
	header(h, copy.title),
	body(h, [
		h.form([h.Id(FORM_ID), h.OnSubmit(Message.SubmittedVercelToken())], [tokenFields(h, configure)]),
	]),
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

const teamStage = (
	h: H,
	configure: VercelConfigureModel,
	teams: ReadonlyArray<VercelTeam>,
): ReadonlyArray<Html> => {
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: configure.team,
		toParentMessage: (message) => Message.GotVercelTeamMessage({ message }),
		items: Arr.map(teams, (team) => ({
			value: team.id,
			id: `vercel-team-${team.id}`,
			inputId: `vercel-team-${team.id}-input`,
		})),
	}
	return [
		header(h, "Connect Vercel"),
		body(h, [
			vstack(h, { gap: "2" }, [
				heading(h, { level: 3, variant: "subsection", id: "vercel-team-heading" }, [
					"Which team should Maple watch?",
				]),
				RadioGroup.radioGroup(
					h,
					{
						label: "Which team should Maple watch?",
						className: "gap-0 divide-y overflow-hidden rounded-md border",
					},
					Arr.map(teams, (team) =>
						hstack(
							h,
							{
								gap: "3",
								className: "px-3 py-2.5 hover:bg-surface-sunken active:bg-surface-sunken",
								attributes: [h.Key(team.id)],
							},
							[
								...RadioGroup.radio(h, config, team.id),
								label(
									h,
									{
										className: "flex min-w-0 flex-1 cursor-pointer gap-3 font-normal",
										attributes: [
											h.Id(RadioGroup.labelId(`vercel-team-${team.id}-input`)),
											h.For(`vercel-team-${team.id}-input`),
										],
									},
									[
										h.span(
											[h.Class("min-w-0 flex-1 truncate text-sm font-medium")],
											[team.name],
										),
										...(onHobby(team)
											? [
													typography(h, { size: "xs", tone: "muted" }, [
														"Hobby: no drains",
													]),
												]
											: []),
										typography(h, { size: "xs", tone: "muted", mono: true }, [team.slug]),
									],
								),
							],
						),
					),
				),
				h.p(
					[h.Class(SMALL)],
					["One team per Maple organization. Drains are created on the team you pick."],
				),
			]),
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
		description: "Deployment traces from Vercel and @vercel/otel.",
	},
	{
		flag: "aiGatewayEnabled",
		title: "AI Gateway",
		drain: "Maple AI Gateway",
		description:
			"Model usage and cost from Vercel AI Gateway: every request with its model, tokens and cost.",
	},
	{
		flag: "speedInsightsEnabled",
		title: "Speed Insights",
		drain: "Maple Speed Insights",
		description:
			"Core Web Vitals (LCP, INP, CLS, FCP, TTFB) from real visits. Needs Speed Insights Plus on the project.",
	},
	{
		flag: "webAnalyticsEnabled",
		title: "Web Analytics",
		drain: "Maple Web Analytics",
		description:
			"Page views and custom events. Needs Web Analytics on the project; Vercel bills each event.",
	},
	{
		flag: "auditLogEnabled",
		title: "Audit log",
		drain: "Maple audit log",
		description:
			"Who changed what on the team, for the whole team whatever projects you pick. Enterprise plan only.",
	},
] as const

const projectList = (
	h: H,
	configure: VercelConfigureModel,
	projects: ReadonlyArray<VercelPickableProject>,
): Html => {
	const query = Str.toLowerCase(Str.trim(configure.projectQuery))
	const shown = Arr.filter(
		projects,
		(project) => query === "" || Str.includes(query)(Str.toLowerCase(project.name)),
	)
	return vstack(h, { className: "overflow-hidden rounded-md border" }, [
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
		dividedList(
			h,
			{ as: "ul", bordered: false, className: "max-h-56 overflow-y-auto" },
			shown.length === 0
				? [
						h.li(
							[h.Class(cn(SMALL, "px-3 py-2"))],
							[
								projects.length === 0
									? "This team has no projects yet."
									: "No project matches.",
							],
						),
					]
				: Arr.map(shown, (project) => {
						const inputId = `vercel-project-${project.id}`
						return h.li(
							[h.Key(project.id)],
							[
								label(
									h,
									{
										className:
											"flex cursor-pointer gap-3 px-3 py-2 font-normal hover:bg-surface-sunken active:bg-surface-sunken",
										attributes: [h.Id(Checkbox.labelId(inputId))],
									},
									[
										...Checkbox.view(h, {
											model: {
												isChecked: configure.draft.projectIds.includes(project.id),
											},
											toParentMessage: () =>
												Message.ToggledVercelProject({ id: project.id }),
											id: `${inputId}-root`,
											inputId,
										}),
										h.span([h.Class("min-w-0 flex-1 truncate text-sm")], [project.name]),
										...(project.framework === null
											? []
											: [
													badge(h, { variant: "meta", size: "xs" }, [
														project.framework,
													]),
												]),
									],
								),
							],
						)
					}),
		),
		h.p(
			[h.Class(cn(SMALL, "border-t bg-surface-faint px-3 py-1.5"))],
			[`${configure.draft.projectIds.length} of ${countLabel(projects.length, "project")} picked`],
		),
	])
}

/** What the drains forward. Shared by connecting and by Configure. */
const settingsFields = (
	h: H,
	configure: VercelConfigureModel,
	projects: ReadonlyArray<VercelPickableProject>,
): Html => {
	const draft = configure.draft
	return vstack(h, { gap: "5" }, [
		h.fieldset(
			[h.Class("flex flex-col gap-2")],
			[
				h.legend([h.Class(cn(TITLE, "mb-2"))], ["What should Vercel send?"]),
				dividedList(
					h,
					{ as: "div", className: "rounded-lg" },
					Arr.map(SIGNALS, (signal) =>
						hstack(
							h,
							{ align: "start", gap: "4", className: "p-3", attributes: [h.Key(signal.flag)] },
							[
								vstack(h, { gap: "0.5", shrink: true, grow: true }, [
									label(
										h,
										{
											className: "flex text-sm sm:text-sm",
											attributes: [
												h.Id(`vercel-${signal.flag}-label`),
												h.For(`vercel-${signal.flag}-input`),
											],
										},
										[
											signal.title,
											badge(h, { variant: "outline", size: "xs", mono: true }, [
												signal.drain,
											]),
										],
									),
									h.p([h.Class(SMALL)], [signal.description]),
								]),
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
		vstack(h, { gap: "2" }, [
			hstack(h, { gap: "3", justify: "between" }, [
				heading(h, { level: 3, variant: "subsection" }, ["Projects"]),
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
			]),
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
		]),
		vstack(h, { gap: "2" }, [
			hstack(h, { gap: "3", justify: "between" }, [
				label(h, { className: "text-sm/5 sm:text-sm/5", attributes: [h.For("vercel-sampling")] }, [
					"Sampling",
				]),
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
					Arr.map(VERCEL_SAMPLING_RATES, (rate) => nativeOption(String(rate), samplingLabel(rate))),
				),
			]),
			h.p(
				[h.Class(SMALL)],
				[
					"Vercel samples logs and traces before it sends, so a lower rate also lowers its bill. The other drains are never sampled, so their counts and totals stay exact.",
				],
			),
		]),
		vercelCostNote(h),
	])
}

/** Vercel's drain pricing in three facts. */
export const vercelCostNote = (h: H): Html =>
	alert(h, { size: "sm", variant: "info", role: "note" }, [
		icon(h, "CircleInfoIcon", { size: 14 }),
		alertTitle(h, ["Vercel bills drains on its side"]),
		alertDescription(h, [
			vstack(h, { as: "ul", gap: "0.5", className: "leading-5" }, [
				h.li(
					[],
					[
						typography(h, { weight: "medium", tone: "foreground" }, ["$0.50 per GB"]),
						" of data sent",
					],
				),
				h.li(
					[],
					[
						typography(h, { weight: "medium", tone: "foreground" }, ["$0.05 per 1,000"]),
						" AI Gateway requests",
					],
				),
				h.li(
					[],
					[
						"Pro and Enterprise plans only. ",
						externalLink(h, "https://vercel.com/docs/drains", "Pricing"),
					],
				),
			]),
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
		body(h, [
			...hobbyWarning(h, team),
			settingsFields(h, configure, projects),
			...refusal(h, "Vercel refused the drains", configure.error),
		]),
		footer(h, [
			footerNote(h, [
				problem ??
					`Creates ${countLabel(Arr.filter(SIGNALS, (signal) => draft[signal.flag]).length, "drain")} on ${team.name} right away.`,
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
			vstack(
				h,
				{ as: "ul", gap: "1", className: "list-disc pb-3 pl-5 text-sm" },
				Arr.map(settingsChange(status, configure).stops, (stop) => h.li([h.Key(stop)], [stop])),
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
	const team = Option.getOrUndefined(
		Arr.findFirst(configure.teams ?? [], (candidate) => candidate.id === teamId),
	)
	if (configure.projects !== null && team !== undefined)
		return connectSettingsStage(h, configure, team, configure.projects)
	if (configure.teams !== null && configure.teams.length > 1)
		return teamStage(h, configure, configure.teams)
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
		...(configure.target === "configure" && status !== null
			? [forwardLessConfirm(h, configure, status)]
			: []),
	]
}
