import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Option } from "effect"
import { button } from "../../../ui/button"
import { field, fieldDescription, fieldError, type FieldIds, fieldLabel } from "../../../ui/field"
import type { FieldState } from "../../../ui/input"
import * as SelectView from "../../../ui/select-view"
import { providerOf } from "../shared/providers"
import type { DestinationForm } from "./form"
import {
	isUsable,
	type LinearTeam,
	Message as LinearMessage,
	type Model as LinearModel,
	TEAM_SELECT_ID,
} from "./linear-fields"

// `LinearFields`' view: a team picker, or connecting Linear in a popup (admins only).

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
const IDS: FieldIds = {
	control: TEAM_SELECT_ID,
	label: SelectView.selectLabelId(TEAM_SELECT_ID),
	error: `${TEAM_SELECT_ID}-error`,
	description: `${TEAM_SELECT_ID}-description`,
}

type Inputs<M> = Readonly<{
	model: LinearModel
	form: DestinationForm
	isEditing: boolean
	toMessage: (message: LinearMessage) => M
}>

const isFailed = <A, E>(data: AsyncData.AsyncData<A, E>) =>
	AsyncData.isFailure(data) || AsyncData.isStale(data)

const isPending = <A, E>(data: AsyncData.AsyncData<A, E>) =>
	AsyncData.isIdle(data) || AsyncData.isLoading(data)

const teamLabel = (team: LinearTeam): string => `${team.name} (${team.key})`

const note = <M>(h: HtmlBuilder<M>, text: string): Html =>
	h.p([h.Class("text-2xs text-muted-foreground")], [text])

/** A re-read of a failed slot keeps the failure on screen, so the button shows it is working. */
const isRetrying = (model: LinearModel): boolean =>
	model.status.retrying === true ||
	model.teams.retrying === true ||
	AsyncData.isRefreshing(model.status.data)

const retry = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>, label: string): Html =>
	button(
		h,
		{
			size: "sm",
			variant: "outline",
			isLoading: isRetrying(inputs.model),
			attributes: [h.OnClick(inputs.toMessage(LinearMessage.ClickedRetry()))],
		},
		[label],
	)

const connectNote = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>, isRevoked: boolean): Html => {
	const { model } = inputs
	const accent = providerOf("linear")
	const isAdmin = model.isAdmin === true
	return h.div(
		[h.Class("space-y-2 rounded-md border border-dashed border-border/60 p-3")],
		[
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				[
					model.isAdmin === false
						? "Ask an org admin to connect Linear on the Integrations page, then check again."
						: isRevoked
							? "Linear revoked Maple's access. Reconnect it, then pick a team here."
							: "Connect your Linear workspace, then pick the team issues open in.",
				],
			),
			...(model.connectNote === null
				? []
				: [
						h.p(
							[h.Class("text-xs text-severity-error")],
							[
								model.connectNote === "Blocked"
									? "Allow pop-ups for Maple, then try again."
									: "Couldn't start the Linear connection. Try again.",
							],
						),
					]),
			h.div(
				[h.Class("flex flex-wrap gap-2")],
				[
					...(model.isAdmin === false
						? []
						: [
								button(
									h,
									{
										size: "sm",
										isLoading: model.isConnecting,
										isDisabled: !isAdmin,
										attributes: [
											h.OnClick(inputs.toMessage(LinearMessage.ClickedConnect())),
											h.Style({
												background: accent.accent,
												"border-color": accent.accent,
												color: model.isConnecting ? "transparent" : accent.accentOn,
											}),
										],
									},
									[isRevoked ? "Reconnect Linear" : "Connect Linear"],
								),
							]),
					retry(h, inputs, "Check again"),
				],
			),
		],
	)
}

const teamField = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>): Html => {
	const { form, model } = inputs
	const teams = AsyncData.getOrElse(model.teams.data, () => [])
	const isLoading = isPending(model.teams.data) || AsyncData.isRefreshing(model.teams.data)
	const selected = teams.find((team) => team.id === form.linearTeamId)
	const placeholder = isLoading
		? "Loading teams…"
		: inputs.isEditing && form.linearTeamName !== ""
			? form.linearTeamName
			: "Pick a team"
	return field(h, { className: "items-stretch gap-1.5", state: IDLE }, [
		fieldLabel(h, { ids: IDS, className: "text-xs", state: IDLE }, "Linear team"),
		h.submodel({
			slotId: TEAM_SELECT_ID,
			model: model.teamSelect,
			view: SelectView.view,
			toParentMessage: (message) => inputs.toMessage(LinearMessage.GotTeamSelectMessage({ message })),
			viewInputs: {
				toView: (parts) => h.div([h.Class("contents")], parts),
				entries: [
					{
						_tag: "Group",
						label: "",
						items: teams.map((team) => ({ value: team.id, label: teamLabel(team) })),
					},
				],
				labelledBy: IDS.label,
				className: "w-full",
				isDisabled: isLoading || teams.length === 0,
				renderValue: () =>
					selected === undefined
						? [h.span([h.Class("text-muted-foreground")], [placeholder])]
						: [teamLabel(selected)],
				renderItem: (option) => [option.label],
			},
		}),
		...(!isLoading && isFailed(model.teams.data)
			? [
					fieldError(
						h,
						{ ids: IDS, className: "text-2xs", state: IDLE },
						"Couldn't load your Linear teams.",
					),
					retry(h, inputs, "Try again"),
				]
			: !isLoading && teams.length === 0
				? [
						note(h, "No teams in this Linear workspace. Create one in Linear, then try again."),
						retry(h, inputs, "Refresh teams"),
					]
				: []),
		fieldDescription(
			h,
			{ ids: IDS, className: "text-2xs", state: IDLE },
			"Opens one issue per rule in this team, and comments when it fires again, changes severity or resolves. Reminders are not sent.",
		),
	])
}

export const linearFields = <M>(h: HtmlBuilder<M>, inputs: Inputs<M>): Html => {
	const { model } = inputs
	if (isPending(model.status.data)) return note(h, "Checking your Linear connection…")
	const status = Option.getOrNull(AsyncData.getData(model.status.data))
	if (status === null)
		return h.div(
			[h.Class("space-y-2")],
			[
				h.p(
					[h.Class("text-xs text-severity-error")],
					["Couldn't check your Linear connection. This may be a temporary issue."],
				),
				retry(h, inputs, "Try again"),
			],
		)
	if (!isUsable(status)) return connectNote(h, inputs, status.revoked)
	return teamField(h, inputs)
}
