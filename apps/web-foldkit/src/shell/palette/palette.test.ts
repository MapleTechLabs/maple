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

describe("command palette", () => {
	test("opening reads the services and loads fuse", () => {
		expect(commandNames(open())).toEqual(["LoadPaletteServices", "PreloadFuse"])
	})

	test("a query is ranked by fuse; an empty one is browse mode and searches nothing", () => {
		expect(commandNames(typed(open().model, "logs"))).toEqual(["SearchPalette"])
		expect(commandNames(typed(open().model, "  "))).toEqual([])
	})

	test("an answer for an older query is dropped", () => {
		const model = typed(open().model, "logs").model
		const stale = update(model, Message.RankedEntries({ query: "log", serviceCount: 0, ids: ["nav:Overview"] }), context)
		expect(stale.model.ranked).toBeNull()
	})

	test("a ranking of the list before the services landed, arriving last, does not replace the newer one", () => {
		const typedStore = typed(open().model, "store").model
		const loaded = update(typedStore, Message.SucceededLoadServices({ serviceNames: ["storefront"] }), context)
		expect(commandNames(loaded)).toEqual(["SearchPalette"])
		const ranked = update(
			loaded.model,
			Message.RankedEntries({ query: "store", serviceCount: 1, ids: ["service:storefront", "dashboard:dsh_1"] }),
			context,
		).model
		const late = update(ranked, Message.RankedEntries({ query: "store", serviceCount: 0, ids: ["dashboard:dsh_1"] }), context)
		expect(late.model.ranked).toEqual(["service:storefront", "dashboard:dsh_1"])
	})

	test("Enter before the ranking arrives picks the top match once it does", () => {
		const model = typed(open().model, "logs").model
		const pressed = update(model, Message.PressedEnter({ isReleasesVisible: true }), context)
		expect(pressed.outMessage).toBeUndefined()
		const ranked = update(
			pressed.model,
			Message.RankedEntries({ query: "logs", serviceCount: 0, ids: ["nav:Explore:Logs", "nav:Overview"] }),
			context,
		)
		expect(ranked.outMessage).toEqual(OutMessage.Navigated({ href: "/logs" }))
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
			["Connect Google Cloud", "Connect Railway"],
		)
	})

	test("a flagged-off Releases row is not shown", () => {
		const titles = (isReleasesVisible: boolean) =>
			shownEntries(open().model, context, isReleasesVisible).entries.map((entry) => entry.title)
		expect(titles(true)).toContain("Releases")
		expect(titles(false)).not.toContain("Releases")
	})
})
