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

const ALL_FLAGGED = ["/releases", "/security"]

describe("command palette", () => {
	test("the input's own update shows the ranked results, with no browse list in between", () => {
		const model = typed(loadedWith(["storefront", "payments"]), "store").model
		const shown = shownEntries(model, context, ALL_FLAGGED)
		expect(shown.isSearch).toBe(true)
		expect(shown.entries[0]?.id).toBe("service:storefront")
	})

	test("word-start matches crowd out fuzzy mid-word ones; a typo still finds fuzzy hits", () => {
		const titles = (query: string) =>
			shownEntries(typed(loadedWith([]), query).model, context, ALL_FLAGGED).entries.map(
				(entry) => entry.title,
			)
		expect(titles("serv")).toEqual(expect.arrayContaining(["Services", "Service Map"]))
		expect(titles("serv")).not.toContain("Overview")
		expect(titles("srevices")).toContain("Services")
	})

	test("a page reachable from two nav rows is listed once", () => {
		const infra = paletteEntries({ ...context, serviceNames: [] }).filter(
			(entry) => entry.target._tag === "Href" && entry.target.href === "/infra",
		)
		expect(infra).toHaveLength(1)
	})

	test("a shared page keeps its specific title and stays findable by its parent's", () => {
		const tracesFor = (query: string) =>
			shownEntries(typed(loadedWith([]), query).model, context, ALL_FLAGGED).entries.filter(
				(entry) => entry.target._tag === "Href" && entry.target.href === "/traces",
			)
		expect(tracesFor("traces").map((entry) => entry.title)).toEqual(["Traces"])
		expect(tracesFor("explore")).toHaveLength(1)
	})

	test("opening reads the services; typing sends nothing", () => {
		expect(commandNames(open())).toEqual(["LoadPaletteServices"])
		expect(commandNames(typed(open().model, "logs"))).toEqual([])
	})

	test("services landing after the query re-rank it in place", () => {
		const typedStore = typed(open().model, "store").model
		expect(shownEntries(typedStore, context, ALL_FLAGGED).entries.map((entry) => entry.id)).not.toContain(
			"service:storefront",
		)
		const loaded = update(
			typedStore,
			Message.SucceededLoadServices({ serviceNames: ["storefront"] }),
			context,
		)
		expect(shownEntries(loaded.model, context, ALL_FLAGGED).entries[0]?.id).toBe("service:storefront")
	})

	test("Enter right after typing picks the top match", () => {
		const model = typed(open().model, "logs").model
		const pressed = update(
			model,
			Message.PressedEnter({ visibleFlagged: ["/releases", "/security"] }),
			context,
		)
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

	test("a flagged-off row is not shown", () => {
		const titles = (visibleFlagged: ReadonlyArray<string>) =>
			shownEntries(open().model, context, visibleFlagged).entries.map((entry) => entry.title)
		expect(titles(ALL_FLAGGED)).toEqual(expect.arrayContaining(["Releases", "Security"]))
		expect(titles(["/security"])).not.toContain("Releases")
		expect(titles(["/releases"])).not.toContain("Security")
	})
})
