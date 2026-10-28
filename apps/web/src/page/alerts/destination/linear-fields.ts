import { Effect, Option, Result, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Keyed from "../../../data/keyed"
import { LoadFailure, toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import type { Resources } from "../../../platform/resources"
import * as Select from "../../../ui/select"
import type { DestinationForm } from "./form"

// `LinearFields`: the org's Linear connection (made on the Integrations page) and the
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
})
export type Model = typeof Model.Type

export const TEAM_SELECT_ID = "destination-linear-team"

export const init = (): Model => ({
	status: Keyed.idle(),
	teams: Keyed.idle(),
	teamSelect: Select.init(TEAM_SELECT_ID, { value: "", selectedIndex: null }),
})

export const Message = defineMessageUnion({
	CompletedFetchStatus: { key: Schema.String, result: Schema.Result(LinearStatus, LoadFailure) },
	CompletedFetchTeams: { key: Schema.String, result: Schema.Result(Schema.Array(LinearTeam), LoadFailure) },
	ClickedRetry: {},
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

const statusAnswered = (
	model: Model,
	key: string,
	result: Result.Result<LinearStatus, LoadFailure>,
): Return => {
	const next = { ...model, status: Keyed.accept(model.status, key, result) }
	const usable = Option.exists(AsyncData.getData(next.status.data), isUsable)
	return usable ? readTeams(next, "Load") : { model: next, commands: [] }
}

const teamName = (model: Model, teamId: string): string =>
	Option.getOrElse(AsyncData.getData(model.teams.data), () => []).find((team) => team.id === teamId)
		?.name ?? ""

export const update = (model: Model, message: Message, form: DestinationForm): Return =>
	Message.match<Return>(message, {
		CompletedFetchStatus: ({ key, result }) => statusAnswered(model, key, result),
		CompletedFetchTeams: ({ key, result }) => {
			const next = { ...model, teams: Keyed.accept(model.teams, key, result) }
			// The stored team's name, once known, keeps the suggested name current.
			const name = teamName(next, form.linearTeamId)
			return name === ""
				? { model: next, commands: [] }
				: { model: next, commands: [], form: { linearTeamName: name } }
		},
		ClickedRetry: () => {
			const status = Option.getOrNull(AsyncData.getData(model.status.data))
			return status !== null && isUsable(status)
				? readTeams(model, "Refresh")
				: readStatus(model, "Refresh")
		},
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

/** The fields mount: the select reads the form, and the status (then the teams) is read. */
export const reset = (model: Model, form: DestinationForm): Return => {
	const mounted = {
		...model,
		teamSelect: Select.init(TEAM_SELECT_ID, { value: form.linearTeamId, selectedIndex: null }),
	}
	const status = readStatus(mounted, "Load")
	// A status already known to be usable (a reopen) reads the teams straight away.
	const usable = Option.exists(AsyncData.getData(status.model.status.data), isUsable)
	if (!usable) return status
	const teams = readTeams(status.model, "Load")
	return { model: teams.model, commands: [...status.commands, ...teams.commands] }
}
