import { Effect, Option, Result, Schedule, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Keyed from "../../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Select from "../../../ui/select"
import { currentReturnPath, startConnect } from "../../integrations/connect"
import { readIsAdmin } from "../shared/commands"
import type { DestinationForm } from "./form"

// `LinearFields`: the org's Linear connection, connected in a popup by an admin, and the
// team this destination opens issues in.

export const LinearStatus = Schema.Struct({
	connected: Schema.Boolean,
	revoked: Schema.Boolean,
	workspaceName: Schema.NullOr(Schema.String),
})
export type LinearStatus = typeof LinearStatus.Type
export const LinearTeam = Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String })
export type LinearTeam = typeof LinearTeam.Type

export const Model = Schema.Struct({
	status: Keyed.KeyedSchema(LinearStatus, LoadFailure),
	teams: Keyed.KeyedSchema(Schema.Array(LinearTeam), LoadFailure),
	teamSelect: Select.Model,
	/** Connecting Linear is admin-only; `null` until the session answers. */
	isAdmin: Schema.NullOr(Schema.Boolean),
	/** The connect popup is out: the status is re-read once it closes. */
	isConnecting: Schema.Boolean,
	/** Bumped per connect and per mount: a popup from an earlier one never settles this form. */
	connectAttempt: Schema.Number,
	/** How the last connect ended, when it needs saying. */
	connectNote: Schema.NullOr(Schema.Literals(["Blocked", "Failed"])),
	/** A failed teams read re-checks the status once, without re-reading the teams after it. */
	isRecheckingStatus: Schema.Boolean,
})
export type Model = typeof Model.Type

export const TEAM_SELECT_ID = "destination-linear-team"

export const init = (): Model => ({
	status: Keyed.idle(),
	teams: Keyed.idle(),
	teamSelect: Select.init(TEAM_SELECT_ID, { value: "", selectedIndex: null }),
	isAdmin: null,
	isConnecting: false,
	connectAttempt: 0,
	connectNote: null,
	isRecheckingStatus: false,
})

export const Message = defineMessageUnion({
	CompletedFetchStatus: { key: Schema.String, result: Schema.Result(LinearStatus, LoadFailure) },
	CompletedFetchTeams: { key: Schema.String, result: Schema.Result(Schema.Array(LinearTeam), LoadFailure) },
	CompletedFetchIsAdmin: { isAdmin: Schema.Boolean },
	ClickedRetry: {},
	ClickedConnect: {},
	CompletedConnect: { attempt: Schema.Number, outcome: Schema.Literals(["Closed", "Blocked", "Failed"]) },
	/** The connect popup finished (`connectReturns`), even one whose close was seen early. */
	ReturnedConnect: {},
	GotTeamSelectMessage: { message: Select.Message },
})
export type Message = typeof Message.Type

const settle = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
	Effect.result(Effect.mapError(effect, toLoadFailure))

export const FetchStatus = Command.define("FetchAlertLinearStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchStatus],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const status = yield* client.integrations.linearStatus()
			return {
				connected: status.connected,
				revoked: status.revoked,
				workspaceName: status.workspaceName,
			}
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchStatus({ key, result })),
		),
})

const FetchTeams = Command.define("FetchAlertLinearTeams", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchTeams],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			const response = yield* client.integrations.linearTeams()
			return response.teams.map((team) => ({ id: team.id, key: team.key, name: team.name }))
		}).pipe(
			settle,
			Effect.map((result) => Message.CompletedFetchTeams({ key, result })),
		),
})

export const FetchIsAdmin = Command.define("FetchAlertLinearIsAdmin", {
	messages: [Message.CompletedFetchIsAdmin],
	execute: Effect.map(readIsAdmin, (isAdmin) => Message.CompletedFetchIsAdmin({ isAdmin })),
})

const WINDOW_NAME = "maple-linear-connect"
const WINDOW_FEATURES = "popup,width=520,height=680"
const POPUP_WAIT = "15 minutes"

/**
 * The popup opens in the click, goes to the authorize URL, and answers once it closes. A blocked
 * popup is reported, never replaced by navigating this tab, which would lose the rule draft.
 */
export const ConnectLinear = Command.define("ConnectAlertLinear", {
	args: { attempt: Schema.Number },
	messages: [Message.CompletedConnect],
	execute: ({ attempt }) =>
		Effect.gen(function* () {
			const popup = yield* Effect.sync(() => window.open("", WINDOW_NAME, WINDOW_FEATURES))
			if (popup === null) return Message.CompletedConnect({ attempt, outcome: "Blocked" })
			const returnTo = yield* currentReturnPath
			const started = yield* Effect.result(startConnect("linear", returnTo))
			if (started._tag === "Failure") {
				yield* Effect.sync(() => popup.close())
				return Message.CompletedConnect({ attempt, outcome: "Failed" })
			}
			const url = started.success.redirectUrl
			yield* Effect.sync(() => {
				popup.location.href = url
			})
			yield* Effect.sync(() => popup.closed).pipe(
				Effect.repeat({ schedule: Schedule.spaced("500 millis"), until: (isClosed) => isClosed }),
				Effect.timeoutOption(POPUP_WAIT),
			)
			return Message.CompletedConnect({ attempt, outcome: "Closed" })
		}),
})

export type Return = Readonly<{
	model: Model
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
	form?: Partial<DestinationForm>
}>

export const STATUS_KEY = "linear\u0000integrations.linearStatus"
const TEAMS_KEY = "linear\u0000integrations.linearTeams"

/** Teams are listed only from a live connection: a revoked grant has nothing to list. */
export const isUsable = (status: LinearStatus): boolean => status.connected && !status.revoked

const readStatus = (model: Model, mode: Keyed.RequestMode): Return =>
	Option.match(Keyed.request(model.status, STATUS_KEY, mode), {
		onNone: () => ({ model, commands: [] }),
		onSome: (status) => ({ model: { ...model, status }, commands: [FetchStatus({ key: STATUS_KEY })] }),
	})

const readTeams = (model: Model, mode: Keyed.RequestMode): Return =>
	Option.match(Keyed.request(model.teams, TEAMS_KEY, mode), {
		onNone: () => ({ model, commands: [] }),
		onSome: (teams) => ({ model: { ...model, teams }, commands: [FetchTeams({ key: TEAMS_KEY })] }),
	})

/** Every status answer re-reads the teams: a reconnect may be to another workspace. */
const statusAnswered = (
	model: Model,
	key: string,
	result: Result.Result<LinearStatus, LoadFailure>,
): Return => {
	const accepted = Keyed.accept(model.status, key, result)
	if (accepted === model.status) return { model, commands: [] }
	const next = { ...model, status: accepted, isRecheckingStatus: false }
	const usable = Option.exists(AsyncData.getData(next.status.data), isUsable)
	return usable && !model.isRecheckingStatus ? readTeams(next, "Refresh") : { model: next, commands: [] }
}

const teamsAnswered = (
	model: Model,
	key: string,
	result: Result.Result<ReadonlyArray<LinearTeam>, LoadFailure>,
	form: DestinationForm,
): Return => {
	const next = { ...model, teams: Keyed.accept(model.teams, key, result) }
	// A failed read may be a grant revoked since the status was read.
	if (next.teams !== model.teams && Result.isFailure(result))
		return readStatus({ ...next, isRecheckingStatus: true }, "Refresh")
	// The stored team's name, once known, keeps the suggested name current.
	const name = teamName(next, form.linearTeamId)
	if (name !== "") return { model: next, commands: [], form: { linearTeamName: name } }
	// A stored team the workspace no longer lists is dead: clear it so the picker and Save agree.
	return Result.isSuccess(result) && form.linearTeamId !== ""
		? { model: next, commands: [], form: { linearTeamId: "", linearTeamName: "" } }
		: { model: next, commands: [] }
}

const teamName = (model: Model, teamId: string): string =>
	Option.getOrElse(AsyncData.getData(model.teams.data), () => []).find((team) => team.id === teamId)
		?.name ?? ""

export const update = (model: Model, message: Message, form: DestinationForm): Return =>
	Message.match<Return>(message, {
		CompletedFetchStatus: ({ key, result }) => statusAnswered(model, key, result),
		CompletedFetchTeams: ({ key, result }) => teamsAnswered(model, key, result, form),
		CompletedFetchIsAdmin: ({ isAdmin }) => ({ model: { ...model, isAdmin }, commands: [] }),
		// The status read chains into the teams when the connection is usable.
		ClickedRetry: () => readStatus({ ...model, isRecheckingStatus: false }, "Refresh"),
		ClickedConnect: () =>
			model.isConnecting || model.isAdmin !== true
				? { model, commands: [] }
				: {
						model: {
							...model,
							isConnecting: true,
							connectAttempt: model.connectAttempt + 1,
							connectNote: null,
						},
						commands: [ConnectLinear({ attempt: model.connectAttempt + 1 })],
					},
		CompletedConnect: ({ attempt, outcome }) => {
			if (attempt !== model.connectAttempt) return { model, commands: [] }
			const settled = { ...model, isConnecting: false, isRecheckingStatus: false }
			return outcome === "Closed"
				? readStatus({ ...settled, connectNote: null }, "Refresh")
				: { model: { ...settled, connectNote: outcome }, commands: [] }
		},
		ReturnedConnect: () =>
			readStatus(
				{ ...model, isConnecting: false, isRecheckingStatus: false, connectNote: null },
				"Refresh",
			),
		GotTeamSelectMessage: ({ message: inner }) => {
			const step = Select.update(model.teamSelect, inner)
			const lifted: Return = {
				model: { ...model, teamSelect: step.model },
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotTeamSelectMessage({ message: child }),
				),
			}
			if (step.outMessage === undefined) return lifted
			const value = step.outMessage.value
			return { ...lifted, form: { linearTeamId: value, linearTeamName: teamName(model, value) } }
		},
	})

/**
 * The fields mount: the select reads the form, the session's role is read once, and the status
 * is read. A cached status that is not usable is re-read, as Linear may be connected since.
 */
export const reset = (model: Model, form: DestinationForm): Return => {
	const mounted = {
		...model,
		isRecheckingStatus: false,
		// A popup from before this mount no longer settles the form.
		isConnecting: false,
		connectAttempt: model.connectAttempt + 1,
		connectNote: null,
		teamSelect: Select.init(TEAM_SELECT_ID, { value: form.linearTeamId, selectedIndex: null }),
	}
	const admin = model.isAdmin === null ? [FetchIsAdmin()] : []
	const isCachedUsable = Option.exists(AsyncData.getData(mounted.status.data), isUsable)
	const status = readStatus(mounted, isCachedUsable ? "Load" : "Refresh")
	// A status already known to be usable (a reopen) reads the teams straight away.
	if (!isCachedUsable) return { ...status, commands: [...admin, ...status.commands] }
	const teams = readTeams(status.model, "Load")
	return { model: teams.model, commands: [...admin, ...status.commands, ...teams.commands] }
}
