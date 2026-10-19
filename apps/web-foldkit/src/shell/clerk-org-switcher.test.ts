import { Option } from "effect"
import { describe, expect, test } from "vitest"
import * as Dialog from "../ui/dialog"
import * as Menu from "../ui/menu"
import * as RadioGroup from "../ui/radio-group"
import {
	CREATE_VALUE,
	createdTargetOf,
	init,
	Message,
	NAMESPACE_PREFIX,
	OutMessage,
	update,
} from "./clerk-org-switcher"

const clickItem = (value: string) =>
	Message.GotMenuMessage({ message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value } }) })

const opened = () => update(init("switcher"), Message.GotMenuMessage({ message: Menu.Message.ClickedTrigger() })).model

const commandNames = (result: ReturnType<typeof update>) => (result.commands ?? []).map((command) => command.name)

describe("Clerk org switcher", () => {
	test("picking an organization reports it to the screen", () => {
		const result = update(opened(), clickItem("org:org_2"))
		expect(result.outMessage).toEqual(OutMessage.SelectedOrganization({ orgId: "org_2" }))
		expect(result.model.menu.isOpen).toBe(false)
	})

	test("Create Organization opens the dialog, which creates only with a name", () => {
		const withDialog = update(opened(), clickItem(CREATE_VALUE)).model
		expect(withDialog.createDialog.isOpen).toBe(true)
		const blank = update(withDialog, Message.SubmittedCreateOrganization())
		expect(commandNames(blank)).toEqual([])
		const named = update(withDialog, Message.ChangedOrganizationName({ value: "  Orbit  " })).model
		const submitted = update(named, Message.SubmittedCreateOrganization())
		expect(submitted.model.isCreating).toBe(true)
		expect((submitted.commands ?? []).map((command) => [command.name, command.args])).toEqual([
			["CreateOrganization", { name: "  Orbit  ", region: "us" }],
		])
		expect(commandNames(update(submitted.model, Message.SubmittedCreateOrganization()))).toEqual([])
	})

	test("a created organization becomes the active one; a failure shows its message", () => {
		const creating = { ...init("switcher"), name: "Orbit", isCreating: true }
		expect(commandNames(update(creating, Message.SucceededCreateOrganization({ orgId: "org_new" })))).toEqual([
			"SwitchOrganization",
		])
		const failed = update(creating, Message.FailedCreateOrganization({ message: "Name taken" })).model
		expect(failed).toMatchObject({ isCreating: false, errorMessage: "Name taken" })
	})

	test("the picked data region is sent; an org in another region lands on that region's app", () => {
		const named = update(
			update(opened(), clickItem(CREATE_VALUE)).model,
			Message.ChangedOrganizationName({ value: "Orbit" }),
		).model
		const picked = update(
			named,
			Message.GotRegionMessage({ message: RadioGroup.Message.SelectedRadio({ value: "eu" }) }),
		).model
		const submitted = update(picked, Message.SubmittedCreateOrganization())
		expect((submitted.commands ?? []).map((command) => command.args)).toEqual([{ name: "Orbit", region: "eu" }])
		expect(createdTargetOf("eu", () => "https://eu.example")).toBe("https://eu.example")
		expect(createdTargetOf("us", () => "https://us.example")).toBeNull()
		const closed = update(picked, Message.GotCreateDialogMessage({ message: Dialog.Message.ClickedClose() })).model
		expect(closed.region).toBe("us")
	})

	test("a namespace row pins it; All namespaces clears the pin", () => {
		const pick = (value: string) =>
			update(
				{ ...opened(), menu: { ...opened().menu, submenu: { index: 3, value: "namespace", side: "right", align: "start", highlighted: null } } },
				Message.GotMenuMessage({ message: Menu.Message.ClickedSubmenuItem({ value }) }),
			).outMessage
		expect(pick(`${NAMESPACE_PREFIX}checkout`)).toEqual(
			OutMessage.SelectedNamespace({ maybeNamespace: Option.some("checkout") }),
		)
		expect(pick("*")).toEqual(OutMessage.SelectedNamespace({ maybeNamespace: Option.none() }))
	})
})
