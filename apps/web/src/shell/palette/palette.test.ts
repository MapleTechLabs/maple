import { describe, expect, test } from "vitest"
import * as Combobox from "../../ui/combobox"
import { browseEntries, paletteEntries } from "./entries"
import { Message, type Model, OutMessage } from "./model"
import { type Context, open, shownEntries, update } from "./update"

// The palette's update: lookups on open, fuse ranking per query, Enter and clicks as picks.

const context: Context = {
	dashboards: [{ id: "dsh_1", name: "Checkout health", updated_at: "2026-10-01" }],
	favorites: [],
	theme: "dark",
}

const commandNames = (result: { commands?: ReadonlyArray<{ name: string }> }) =>
	result.commands?.map((command) => command.name) ?? []

const typed = (model: Model, value: string) =>
	update(model, Message.GotListMessage({ message: Combobox.Message.ChangedInput({ value }) }), context)

const loadedWith = (serviceNames: ReadonlyArray<string>) =>
	update(open().model, Message.SucceededLoadServices({ serviceNames }), context).model

describe("command palette", () => {
	test("the input's own update shows the ranked results, with no browse list in between", () => {
		const model = typed(loadedWith(["storefront", "payments"]), "store").model
		const shown = shownEntries(model, context, true)
		expect(shown.isSearch).toBe(true)
		expect(shown.entries[0]?.id).toBe("service:storefront")
	})

	test("opening reads the services; typing sends nothing", () => {
		expect(commandNames(open())).toEqual(["LoadPaletteServices"])
		expect(commandNames(typed(open().model, "logs"))).toEqual([])
	})

	test("services landing after the query re-rank it in place", () => {
		const typedStore = typed(open().model, "store").model
		expect(shownEntries(typedStore, context, true).entries.map((entry) => entry.id)).not.toContain(
			"service:storefront",
		)
		const loaded = update(typedStore, Message.SucceededLoadServices({ serviceNames: ["storefront"] }), context)
		expect(shownEntries(loaded.model, context, true).entries[0]?.id).toBe("service:storefront")
	})

	test("Enter right after typing picks the top match", () => {
		const model = typed(open().model, "logs").model
		const pressed = update(model, Message.PressedEnter({ isReleasesVisible: true }), context)
		expect(pressed.outMessage).toEqual(OutMessage.Navigated({ href: "/logs" }))
	})

	test("clicking a link only closes (the link navigates); an action runs", () => {
		const model = open().model
		expect(update(model, Message.ClickedEntry({ id: "nav:Overview" }), context).outMessage).toEqual(
			OutMessage.Closed(),
		)
		expect(
			update(model, Message.ClickedEntry({ id: "action:toggle-theme" }), context).outMessage,
		).toEqual(OutMessage.RanAction({ action: "ToggleTheme" }))
	})

	test("browse mode shows five services and only the new providers", () => {
		const serviceNames = ["a", "b", "c", "d", "e", "f"]
		const browsed = browseEntries(paletteEntries({ ...context, serviceNames }))
		expect(browsed.filter((entry) => entry.group === "Services").map((entry) => entry.title)).toEqual(
			serviceNames.slice(0, 5),
		)
		expect(browsed.filter((entry) => entry.group === "Integrations").map((entry) => entry.title)).toEqual(
			["Connect Google Cloud", "Connect AWS", "Connect Railway", "Connect Supabase"],
		)
	})

	test("every chat connector is typeable as Connect <name>, with no per-org gate", () => {
		const titles = paletteEntries({ ...context, serviceNames: [] }).map((entry) => entry.title)
		expect(titles).toEqual(expect.arrayContaining(["Connect Slack", "Connect Discord"]))
	})

	test("a flagged-off Releases row is not shown", () => {
		const titles = (isReleasesVisible: boolean) =>
			shownEntries(open().model, context, isReleasesVisible).entries.map((entry) => entry.title)
		expect(titles(true)).toContain("Releases")
		expect(titles(false)).not.toContain("Releases")
	})
})
