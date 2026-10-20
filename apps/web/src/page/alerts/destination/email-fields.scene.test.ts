import { defaultDestinationForm } from "@maple/web-data/alerts/form-utils"
import { Result } from "effect"
import { Submodel } from "foldkit"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Combobox from "../../../ui/combobox"
import { isFormReady } from "./dialog"
import { init, Message, type Model, reset, update, visibleIds } from "./email-fields"
import { emailFields } from "./email-fields-view"

const members = [
	{ userId: "user_ada", label: "Ada Lovelace", meta: "ada@acme.test" },
	{ userId: "user_bob", label: "bob@acme.test", meta: null },
]
const form = defaultDestinationForm("email")
const loaded = () => update(reset(init(), form).model, Message.CompletedFetchMembers({ result: Result.succeed(members) })).model

describe("email member picker", () => {
	test("mounting reads the members once; a pick is the form's recipients", () => {
		const mounted = reset(init(), form)
		expect(mounted.commands.map(({ name }) => name)).toEqual(["FetchAlertEmailMembers"])
		expect(reset(loaded(), form).commands).toEqual([])
		const picked = update(loaded(), Message.GotComboboxMessage({ message: Combobox.Message.ClickedItem({ value: "user_ada" }) }))
		expect(picked.form).toEqual({ memberUserIds: ["user_ada"] })
		expect(isFormReady({ ...form, memberUserIds: ["user_ada"] }, false)).toBe(true)
	})

	test("the typeahead matches the member's name, never the user id", () => {
		expect(visibleIds(members, "ada")).toEqual(["user_ada"])
		expect(visibleIds(members, "user")).toEqual([])
	})

	test("a picked member's chip reads their name", () => {
		const model = { ...loaded(), combobox: Combobox.init("destination-email-members", "multiple", { selected: ["user_ada"] }) }
		const picker = Submodel.defineView<Model, Message, Readonly<{ isOpen: boolean }>>((current, _inputs, h) =>
			h.main([], [emailFields(h, { model: current, form: { ...form, memberUserIds: ["user_ada"] }, toMessage: (message) => message })]),
		)
		const view = withViewInputs(picker, { isOpen: false })()
		scene(
			{ update: (current: typeof model, message: Message) => ({ model: update(current, message).model }), view },
			given(model),
			expectView(text("Ada Lovelace")).toExist(),
			expectView(role("button", { name: "Remove" })).toExist(),
		)
	})
})
