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

const withStatus = (status: LinearStatus, current: DestinationForm = form) => {
	const mounted = reset(init(), current).model
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
	test("mounting reads the connection; the teams are read only once it is live", () => {
		expect(names(reset(init(), form))).toEqual(["FetchAlertLinearStatus"])
		expect(names(withStatus(CONNECTED))).toEqual(["FetchAlertLinearTeams"])
		expect(names(withStatus({ ...CONNECTED, revoked: true }))).toEqual([])
		expect(names(withStatus({ connected: false, revoked: false, workspaceName: null }))).toEqual([])
	})

	test("not connected, the fields point to the Integrations page instead of a picker", () => {
		const model = withStatus({ connected: false, revoked: false, workspaceName: null }).model
		scene(
			{
				update: (current: Model, message: Message) => ({
					model: update(current, message, form).model,
				}),
				view: render(),
			},
			given(model),
			expectView(role("link", { name: "Connect Linear" })).toHaveAttr(
				"href",
				"/integrations?integration=linear",
			),
			expectView(role("combobox", { name: "Linear team" })).toBeAbsent(),
		)
		shows(withStatus({ ...CONNECTED, revoked: true }).model, "Reconnect Linear")
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

	test("no teams and a failed read both say so, and offer to read again", () => {
		shows(withTeams([]).model, "No teams in this Linear workspace. Create one in Linear, then try again.")
		const status = withStatus(CONNECTED).model
		const failed = update(
			status,
			Message.CompletedFetchTeams({
				key: status.teams.key ?? "",
				result: Result.fail(toLoadFailure("Linear is down")),
			}),
			form,
		).model
		shows(failed, "Couldn't load your Linear teams.")
		expect(names(update(failed, Message.ClickedRetry(), form))).toEqual(["FetchAlertLinearTeams"])
	})
})
