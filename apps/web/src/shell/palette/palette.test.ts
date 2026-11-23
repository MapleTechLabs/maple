import { describe, expect, test } from "vitest"
import * as Combobox from "@maple/views/ui/combobox"
import { browseEntries, paletteEntries } from "./entries"
import { Message, type Model, OutMessage } from "./model"
import { type Context, open, shownEntries, update } from "./update"
import { Array as Arr } from "effect"

// The palette's update: lookups on open, fuzzy ranking per query, Enter and clicks as picks.

const context: Context = {
	dashboards: [{ id: "dsh_1", name: "Checkout health", updated_at: "2026-10-01" }],
	favorites: [],
	theme: "dark",
}

const commandNames = (result: { commands?: ReadonlyArray<{ name: string }> }) =>
	Arr.map(result.commands ?? [], (command) => command.name)

const typed = (model: Model, value: string) =>
	update(model, Message.GotListMessage({ message: Combobox.Message.ChangedInput({ value }) }), context)

const loadedWith = (serviceNames: ReadonlyArray<string>) =>
	update(open().model, Message.SucceededLoadServices({ serviceNames }), context).model

/** Every flagged row but Cost, whose children the section tests hide. */
const ALL_FLAGGED = ["/security"]

describe("command palette", () => {
	test("the input's own update shows the ranked results, with no browse list in between", () => {
		const model = typed(loadedWith(["storefront", "payments"]), "store").model
		const shown = shownEntries(model, context, ALL_FLAGGED)
		expect(shown.isSearch).toBe(true)
		expect(shown.entries[0]?.id).toBe("service:storefront")
	})

	test("word-start matches crowd out fuzzy mid-word ones; a typo still finds fuzzy hits", () => {
		const titles = (query: string) =>
			Arr.map(
				shownEntries(typed(loadedWith([]), query).model, context, ALL_FLAGGED).entries,
				(entry) => entry.title,
			)
		expect(titles("serv")).toEqual(expect.arrayContaining(["Services", "Service map"]))
		expect(titles("serv")).not.toContain("Overview")
		expect(titles("srevices")).toContain("Services")
	})

	test("a page reachable from two nav rows is listed once", () => {
		const infra = Arr.filter(
			paletteEntries({ ...context, serviceNames: [] }),
			(entry) => entry.target._tag === "Href" && entry.target.href === "/infra",
		)
		expect(infra).toHaveLength(1)
	})

	test("a shared page keeps its specific title and stays findable by its parent's", () => {
		const tracesFor = (query: string) =>
			Arr.filter(
				shownEntries(typed(loadedWith([]), query).model, context, ALL_FLAGGED).entries,
				(entry) => entry.target._tag === "Href" && entry.target.href === "/traces",
			)
		expect(Arr.map(tracesFor("traces"), (entry) => entry.title)).toEqual(["Traces"])
		expect(tracesFor("explore")).toHaveLength(1)
	})

	test("a re-render with the same inputs reuses the ranked entries; a new query ranks again", () => {
		const model = typed(loadedWith(["storefront"]), "store").model
		const first = shownEntries(model, { ...context }, [...ALL_FLAGGED])
		expect(shownEntries(model, { ...context }, [...ALL_FLAGGED])).toBe(first)
		const retyped = typed(model, "logs").model
		expect(
			Arr.map(shownEntries(retyped, context, ALL_FLAGGED).entries, (entry) => entry.title),
		).toContain("Logs")
	})

	test("hovering the row that is already highlighted keeps the palette model", () => {
		const model = typed(loadedWith([]), "logs").model
		const hover = (from: Model) =>
			update(
				from,
				Message.GotListMessage({ message: Combobox.Message.HighlightedItem({ index: 1 }) }),
				context,
			).model
		const hovered = hover(model)
		expect(hovered.list.highlighted).toBe(1)
		expect(hover(hovered)).toBe(hovered)
	})

	test("opening reads the services; typing sends nothing", () => {
		expect(commandNames(open())).toEqual(["LoadPaletteServices"])
		expect(commandNames(typed(open().model, "logs"))).toEqual([])
	})

	test("services landing after the query re-rank it in place", () => {
		const typedStore = typed(open().model, "store").model
		expect(
			Arr.map(shownEntries(typedStore, context, ALL_FLAGGED).entries, (entry) => entry.id),
		).not.toContain("service:storefront")
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
			Message.PressedEnter({ visibleFlagged: ALL_FLAGGED, audience: "operator" }),
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
		expect(
			Arr.map(
				Arr.filter(browsed, (entry) => entry.group === "Services"),
				(entry) => entry.title,
			),
		).toEqual(serviceNames.slice(0, 5))
		expect(
			Arr.map(
				Arr.filter(browsed, (entry) => entry.group === "Integrations"),
				(entry) => entry.title,
			),
		).toEqual([
			"Connect Google Cloud",
			"Connect AWS",
			"Connect Railway",
			"Connect Supabase",
			"Connect Vercel",
			"Connect Google Search Console",
			"Connect Fleet",
		])
	})

	test("every chat connector is typeable as Connect <name>, with no per-org gate", () => {
		const titles = Arr.map(paletteEntries({ ...context, serviceNames: [] }), (entry) => entry.title)
		expect(titles).toEqual(expect.arrayContaining(["Connect Slack", "Connect Discord"]))
	})

	test("an analyst finds their own pages and dashboards, not setup or the explorers", () => {
		const model = loadedWith(["storefront"])
		const shown = (query: string) =>
			Arr.map(
				shownEntries(typed(model, query).model, context, ["/cost"], "analyst").entries,
				(entry) => entry.title,
			)
		expect(shown("analytics")).toContain("Web analytics")
		// Their sidebar calls the alerts inbox Incidents, so that is what they search for and see.
		expect(shown("incidents")).toContain("Incidents")
		expect(shown("alerts")).not.toContain("Alerts")
		expect(shown("checkout")).toContain("Checkout health")
		expect(shown("traces")).not.toContain("Traces")
		expect(shown("connect")).toEqual([])
		expect(shown("storefront")).not.toContain("storefront")
		expect(shown("settings")).not.toContain("Settings")
		// The same queries still find them for everyone else.
		const operator = Arr.map(
			shownEntries(typed(model, "traces").model, context, ALL_FLAGGED, "operator").entries,
			(entry) => entry.title,
		)
		expect(operator).toContain("Traces")
	})

	test("Enter opens the page an analyst sees highlighted, not the full list's", () => {
		const model = typed(loadedWith([]), "uptime").model
		const result = update(
			model,
			Message.PressedEnter({ visibleFlagged: [], audience: "analyst" }),
			context,
		)
		expect(result.outMessage).toEqual(OutMessage.Navigated({ href: "/alerts/uptime" }))
	})

	test("a flagged-off row is not shown", () => {
		const titles = (visibleFlagged: ReadonlyArray<string>) =>
			Arr.map(shownEntries(open().model, context, visibleFlagged).entries, (entry) => entry.title)
		expect(titles(["/status-pages", "/security"])).toEqual(
			expect.arrayContaining(["Status pages", "Security"]),
		)
		expect(titles(["/security"])).not.toContain("Status pages")
		expect(titles(["/status-pages"])).not.toContain("Security")
		expect(titles([])).toContain("Cloud cost")
	})

	// "Status pages" is the one title with a word starting "pages". Hidden, it must not be what
	// decides that the looser matches drop out.
	test("a hidden row's better match does not push out what the viewer can open", () => {
		const model = typed(loadedWith(["page-store"]), "pages").model
		const ids = (visibleFlagged: ReadonlyArray<string>) =>
			Arr.map(shownEntries(model, context, visibleFlagged).entries, (entry) => entry.id)

		expect(ids(ALL_FLAGGED)).toContain("service:page-store")
		expect(ids(["/status-pages"])).not.toContain("service:page-store")
	})
})

// The top three per query as the earlier search library ranked them, except where noted.
describe("command palette ranking", () => {
	const top3 = (query: string) =>
		Arr.map(
			shownEntries(
				typed(loadedWith(["storefront", "payments", "page-store"]), query).model,
				context,
				ALL_FLAGGED,
			).entries,
			(entry) => entry.title,
		).slice(0, 3)

	test.each([
		// Exact, prefix and word-start hits.
		["logs", ["Logs"]],
		["Services", ["Services", "Kubernetes Services"]],
		["serv", ["Services", "Service map", "Kubernetes Services"]],
		["dash", ["Dashboards"]],
		["map", ["Service map"]],
		["store", ["storefront", "page-store"]],
		["service map", ["Service map"]],
		["connect slack", ["Connect Slack"]],
		["checkout", ["Checkout health"]],
		// Mid-word only: the fuzzy hits stay.
		["ices", ["Services", "Kubernetes Services", "Metrics"]],
		["board", ["Dashboards", "Keyboard shortcuts", "Checkout health"]],
		// One typo.
		["dashbaord", ["Dashboards", "Checkout health"]],
		["trcaes", ["Traces", "Sources", "Integrations"]],
		["setings", ["Settings"]],
		["alrts", ["Alerts"]],
		// "Service map" is two edits away and now listed third.
		["srevices", ["Services", "Kubernetes Services", "Service map"]],
		// A swapped pair is one edit: "Logs" is found (only "SLOs" was).
		["lgos", ["Logs", "SLOs"]],
		// Keywords only.
		["explore", ["Traces"]],
		["theme", ["Switch to light mode"]],
		// "Sources" lists ingest as a keyword; "Settings" was first on a fuzzy hit.
		["ingest", ["Sources", "Settings", "Keyboard shortcuts"]],
		// Title prefixes before word starts inside a name ("page-store" was second).
		["s", ["storefront", "Supabase", "SLOs"]],
		// No match.
		["zzqxvj", []],
		["api key", []],
	])("%s", (query, expected) => {
		expect(top3(query)).toEqual(expected)
	})
})
