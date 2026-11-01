import { defaultDestinationForm } from "@maple/web-data/alerts/form-utils"
import { Result } from "effect"
import { Submodel } from "foldkit"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import * as Select from "../../../ui/select"
import { isFormReady } from "./dialog"
import type { DestinationForm } from "./form"
import { init, type LinearStatus, Message, type Model, reset, update } from "./linear-fields"
import { linearFields } from "./linear-fields-view"

const names = (step: { readonly commands: ReadonlyArray<{ readonly name: string }> }) =>
	step.commands.map(({ name }) => name)
const form = defaultDestinationForm("linear")
const team = { id: "team_eng", key: "ENG", name: "Engineering" }
const CONNECTED: LinearStatus = { connected: true, revoked: false, workspaceName: "Acme" }

const NOT_CONNECTED: LinearStatus = { connected: false, revoked: false, workspaceName: null }

const withStatus = (status: LinearStatus, current: DestinationForm = form, isAdmin = true) => {
	const mounted = update(
		reset(init(), current).model,
		Message.CompletedFetchIsAdmin({ isAdmin }),
		current,
	).model
	return update(
		mounted,
		Message.CompletedFetchStatus({ key: mounted.status.key ?? "", result: Result.succeed(status) }),
		current,
	)
}

const withTeams = (teams: ReadonlyArray<typeof team>, current: DestinationForm = form) => {
	const status = withStatus(CONNECTED, current).model
	return update(
		status,
		Message.CompletedFetchTeams({ key: status.teams.key ?? "", result: Result.succeed(teams) }),
		current,
	)
}

const render = (current: DestinationForm = form, isEditing = false) => {
	const fields = Submodel.defineView<Model, Message, Readonly<{ isOpen: boolean }>>((next, _inputs, h) =>
		h.main(
			[],
			[linearFields(h, { model: next, form: current, isEditing, toMessage: (message) => message })],
		),
	)
	return withViewInputs(fields, { isOpen: false })()
}

const shows = (model: Model, ...lines: ReadonlyArray<string>) =>
	scene(
		{
			update: (current: Model, message: Message) => ({ model: update(current, message, form).model }),
			view: render(),
		},
		given(model),
		...lines.map((line) => expectView(text(line)).toExist()),
	)

describe("linear destination fields", () => {
	test("mounting reads the role and the connection; the teams are read only once it is live", () => {
		expect(names(reset(init(), form))).toContain("FetchAlertLinearStatus")
		expect(names(reset(init(), form))).not.toContain("FetchAlertLinearTeams")
		expect(names(withStatus(CONNECTED))).toEqual(["FetchAlertLinearTeams"])
		expect(names(withStatus({ ...CONNECTED, revoked: true }))).toEqual([])
		expect(names(withStatus(NOT_CONNECTED))).toEqual([])
	})

	test("a reopen re-reads a connection that was not usable, so one made since shows up", () => {
		const reopened = reset(withStatus(NOT_CONNECTED).model, form)
		expect(names(reopened)).toEqual(["FetchAlertLinearStatus"])
		const connected = update(
			reopened.model,
			Message.CompletedFetchStatus({
				key: reopened.model.status.key ?? "",
				result: Result.succeed(CONNECTED),
			}),
			form,
		)
		expect(names(connected)).toEqual(["FetchAlertLinearTeams"])
	})

	test("not connected, an admin connects in a popup and the connection is re-read after it", () => {
		const model = withStatus(NOT_CONNECTED).model
		scene(
			{
				update: (current: Model, message: Message) => ({
					model: update(current, message, form).model,
				}),
				view: render(),
			},
			given(model),
			expectView(role("combobox", { name: "Linear team" })).toBeAbsent(),
			expectView(role("button", { name: "Check again" })).toExist(),
			expectView(role("button", { name: "Connect Linear" })).toExist(),
		)
		const connecting = update(model, Message.ClickedConnect(), form)
		expect(names(connecting)).toEqual(["ConnectAlertLinear"])
		expect(update(connecting.model, Message.ClickedConnect(), form).commands).toEqual([])
		const returned = update(
			connecting.model,
			Message.CompletedConnect({ attempt: connecting.model.connectAttempt, outcome: "Closed" }),
			form,
		)
		expect(names(returned)).toEqual(["FetchAlertLinearStatus"])
		shows(withStatus({ ...CONNECTED, revoked: true }).model, "Reconnect Linear")
	})

	test("the popup coming back reads the status even after its close settled the form", () => {
		const connecting = update(withStatus(NOT_CONNECTED).model, Message.ClickedConnect(), form).model
		const closed = update(
			connecting,
			Message.CompletedConnect({ attempt: connecting.connectAttempt, outcome: "Closed" }),
			form,
		).model
		const stale = update(
			closed,
			Message.CompletedFetchStatus({
				key: closed.status.key ?? "",
				result: Result.succeed(NOT_CONNECTED),
			}),
			form,
		).model
		expect(names(update(stale, Message.ReturnedConnect(), form))).toEqual(["FetchAlertLinearStatus"])
	})

	test("a reopen frees Connect, and the earlier popup's close no longer settles the form", () => {
		const connecting = update(withStatus(NOT_CONNECTED).model, Message.ClickedConnect(), form).model
		const earlier = connecting.connectAttempt
		const reopened = reset(connecting, form).model
		scene(
			{
				update: (current: Model, message: Message) => ({
					model: update(current, message, form).model,
				}),
				view: render(),
			},
			given(reopened),
			expectView(role("button", { name: "Connect Linear" })).toBeEnabled(),
		)
		const late = update(reopened, Message.CompletedConnect({ attempt: earlier, outcome: "Closed" }), form)
		expect(late.commands).toEqual([])
		expect(names(update(reopened, Message.ClickedConnect(), form))).toContain("ConnectAlertLinear")
	})

	test("a blocked popup asks to allow pop-ups instead of leaving the page", () => {
		const connecting = update(withStatus(NOT_CONNECTED).model, Message.ClickedConnect(), form).model
		const blocked = update(
			connecting,
			Message.CompletedConnect({ attempt: connecting.connectAttempt, outcome: "Blocked" }),
			form,
		)
		expect(blocked.commands).toEqual([])
		shows(blocked.model, "Allow pop-ups for Maple, then try again.")
	})

	test("a member is asked to find an admin, and can check again once one connected", () => {
		const model = withStatus(NOT_CONNECTED, form, false).model
		scene(
			{
				update: (current: Model, message: Message) => ({
					model: update(current, message, form).model,
				}),
				view: render(),
			},
			given(model),
			expectView(
				text("Ask an org admin to connect Linear on the Integrations page, then check again."),
			).toExist(),
			expectView(role("button", { name: "Connect Linear" })).toBeAbsent(),
		)
		expect(update(model, Message.ClickedConnect(), form).commands).toEqual([])
		expect(names(update(model, Message.ClickedRetry(), form))).toEqual(["FetchAlertLinearStatus"])
	})

	test("a picked team is the form's, and makes the destination savable", () => {
		const listed = withTeams([team])
		expect(isFormReady(form, false)).toBe(false)
		const picked = update(
			listed.model,
			Message.GotTeamSelectMessage({
				message: Select.Message.SelectedItem({ index: 0, value: team.id }),
			}),
			form,
		)
		const chosen = { ...form, ...picked.form }
		expect([chosen.linearTeamId, chosen.linearTeamName]).toEqual(["team_eng", "Engineering"])
		expect(isFormReady(chosen, false)).toBe(true)
		scene(
			{
				update: (current: Model, message: Message) => ({
					model: update(current, message, chosen).model,
				}),
				view: render(chosen),
			},
			given(picked.model),
			expectView(text("Engineering (ENG)")).toExist(),
		)
	})

	test("an edit's stored team shows as picked once the teams load", () => {
		const stored = { ...form, linearTeamId: team.id, linearTeamName: "Engineering" }
		const listed = withTeams([team], stored)
		expect(listed.model.teamSelect.value).toBe(team.id)
		scene(
			{
				update: (current: Model, message: Message) => ({
					model: update(current, message, stored).model,
				}),
				view: render(stored, true),
			},
			given(listed.model),
			expectView(text("Engineering (ENG)")).toExist(),
		)
	})

	test("an edit's stored team that the workspace no longer lists is cleared", () => {
		const stored = { ...form, linearTeamId: "team_gone", linearTeamName: "Old team" }
		const listed = withTeams([team], stored)
		expect(listed.form).toEqual({ linearTeamId: "", linearTeamName: "" })
	})

	test("a failed teams read re-checks the connection once; a revoked grant then asks to reconnect", () => {
		shows(withTeams([]).model, "No teams in this Linear workspace. Create one in Linear, then try again.")
		const status = withStatus(CONNECTED).model
		const failed = update(
			status,
			Message.CompletedFetchTeams({
				key: status.teams.key ?? "",
				result: Result.fail(toLoadFailure("Linear is down")),
			}),
			form,
		)
		expect(names(failed)).toEqual(["FetchAlertLinearStatus"])
		const stillUp = update(
			failed.model,
			Message.CompletedFetchStatus({
				key: failed.model.status.key ?? "",
				result: Result.succeed(CONNECTED),
			}),
			form,
		)
		expect(names(stillUp)).toEqual([])
		shows(stillUp.model, "Couldn't load your Linear teams.")
		const revoked = update(
			failed.model,
			Message.CompletedFetchStatus({
				key: failed.model.status.key ?? "",
				result: Result.succeed({ ...CONNECTED, revoked: true }),
			}),
			form,
		).model
		shows(revoked, "Reconnect Linear")
	})

	test("Try again re-reads the connection, then the teams, and shows it is working", () => {
		const status = withStatus(CONNECTED).model
		const failed = update(
			status,
			Message.CompletedFetchTeams({
				key: status.teams.key ?? "",
				result: Result.fail(toLoadFailure("down")),
			}),
			form,
		)
		const checked = update(
			failed.model,
			Message.CompletedFetchStatus({
				key: failed.model.status.key ?? "",
				result: Result.succeed(CONNECTED),
			}),
			form,
		).model
		const retried = update(checked, Message.ClickedRetry(), form)
		expect(names(retried)).toEqual(["FetchAlertLinearStatus"])
		scene(
			{
				update: (current: Model, message: Message) => ({
					model: update(current, message, form).model,
				}),
				view: render(),
			},
			given(retried.model),
			expectView(role("button", { name: "Try again" })).toHaveAttr("aria-disabled", "true"),
		)
		const answered = update(
			retried.model,
			Message.CompletedFetchStatus({
				key: retried.model.status.key ?? "",
				result: Result.succeed(CONNECTED),
			}),
			form,
		)
		expect(names(answered)).toEqual(["FetchAlertLinearTeams"])
	})
})
