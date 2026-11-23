import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr, Option, String as Str } from "effect"
import { AsyncData } from "foldkit"
import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	label,
	Mount,
	role,
	scene,
	selector,
	Subscription,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { formatErrorRate, formatThroughput } from "@maple/ui/lib/format"
import * as Chart from "@maple/views/charts/chart"
import { hoveredPointLabel, MountSparkline } from "@maple/views/charts/sparkline"
import { ThemeMessage, ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { requestKey } from "@maple/views/data/request-key"
import { PageOutMessage, type PageContext } from "../../contract"
import {
	FetchAnomalies,
	FetchBaseline,
	FetchCommitSummaries,
	FetchFacets,
	FetchOverview,
	FetchSparklines,
	MountTable,
} from "./command"
import { Message } from "./message"
import type { Model, ServiceRow, Sparklines } from "./model"
import { init, overviewInput, routeChanged, ScrollFocusedRow, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const row = (serviceName: string, environment = "production", serviceNamespace = ""): ServiceRow => ({
	serviceName,
	serviceNamespace,
	environment,
	commits: [],
	p50LatencyMs: 10,
	p95LatencyMs: 20,
	p99LatencyMs: 30,
	errorRate: 0,
	throughput: 1,
	tracedThroughput: 1,
	hasSampling: false,
	samplingWeight: 1,
	spanCount: 100,
})

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const overviewKey = (input = overviewInput({}, window, null)) =>
	requestKey(orgId, "getServiceOverview", { data: input })

/** Entered and windowed: every query in flight. */
const windowed = (): Model => {
	const entered = init({ search: {} }, context).model
	return pageUpdate(entered, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })).model
}

/** Everything the table blocks on has loaded, with `rows` and the given sparkline series (none by default). */
const loaded = (rows: ReadonlyArray<ServiceRow>, sparklines: Sparklines = {}): Model => {
	const base = windowed()
	const steps: ReadonlyArray<Message> = [
		Message.CompletedFetchOverview({ key: base.overview.key ?? "", result: Result.succeed(rows) }),
		Message.CompletedFetchSparklines({
			key: base.sparklines.key ?? "",
			result: Result.succeed(sparklines),
		}),
		Message.CompletedFetchAnomalies({ key: base.anomalies.key ?? "", result: Result.succeed([]) }),
		Message.CompletedFetchFacets({
			key: base.facets.key ?? "",
			result: Result.succeed({
				environments: [{ name: "production", count: 10 }],
				namespaces: [],
				commitShas: [],
			}),
		}),
		Message.UpdatedIncidents({ orgId, incidents: [] }),
		Message.CompletedLoadChartRuntime(),
		Message.ResolvedThemeColors({ colors: {} }),
	]
	return Arr.reduce(steps, base, (model, message) => pageUpdate(model, message).model)
}

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const withPresence = (model: Model, status: "present" | "absent"): Model =>
	pageUpdate(
		model,
		Message.CompletedLoadSignalPresence({
			result: Result.succeed({ traces: { status, lastSeenMs: null } }),
		}),
	).model

describe("services list", () => {
	test("entry resolves the window, then asks every query the page reads under its key", () => {
		const { commands } = init({ search: {} }, context)
		expect(names(commands)).toContain("ResolveServicesWindow")
		const entered = init({ search: {} }, context).model
		const resolved = pageUpdate(
			entered,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual(
			expect.arrayContaining([
				FetchOverview.name,
				FetchSparklines.name,
				FetchFacets.name,
				FetchBaseline.name,
				FetchAnomalies.name,
			]),
		)
		const fetch = Arr.findFirst(resolved.commands ?? [], ({ name }) => name === FetchOverview.name)
		expect(Option.getOrUndefined(fetch)?.args).toMatchObject({
			input: { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" },
		})
		expect(resolved.model.overview.key).toBe(overviewKey())
	})

	test("the org namespace pin overrides the URL's namespace filters in the request", () => {
		const input = overviewInput({ namespaces: ["a"], excludedNamespaces: ["b"] }, window, "shop")
		expect(input.namespaces).toEqual(["shop"])
		expect(input.excludedNamespaces).toBeUndefined()
	})

	test("an overview answer for a superseded window is dropped", () => {
		const first = windowed()
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Load" }),
		).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchOverview({
				key: first.overview.key ?? "",
				result: Result.succeed([row("stale")]),
			}),
		)
		expect(late.model.overview).toEqual(second.overview)
	})

	test("an incident snapshot read for another org is dropped", () => {
		const model = windowed()
		const other = pageUpdate(model, Message.UpdatedIncidents({ orgId: "org_other", incidents: [] }))
		expect(AsyncData.isLoading(other.model.incidents)).toBe(true)
	})

	test("a failed alert sync and anomaly read do not hold the table on its skeleton", () => {
		const base = windowed()
		const steps: ReadonlyArray<Message> = [
			Message.CompletedFetchOverview({
				key: base.overview.key ?? "",
				result: Result.succeed([row("checkout")]),
			}),
			Message.CompletedFetchSparklines({ key: base.sparklines.key ?? "", result: Result.succeed({}) }),
			Message.CompletedFetchAnomalies({
				key: base.anomalies.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
			Message.FailedLoadIncidents({ orgId }),
			Message.CompletedLoadChartRuntime(),
			Message.ResolvedThemeColors({ colors: {} }),
		]
		scene(
			{ update: pageUpdate, view },
			given(Arr.reduce(steps, base, (model, message) => pageUpdate(model, message).model)),
			themeResolved(),
			Mount.resolve(MountTable, Message.PaintedTable()),
			expectView(role("table", { name: "Services" })).toExist(),
			expectView(text("checkout")).toExist(),
			// The table still paints, and says its health is not known.
			expectView(text("Couldn't load alert status or anomalies")).toExist(),
		)
	})

	test("a late alert-sync failure does not replace incidents that already arrived", () => {
		const synced = pageUpdate(windowed(), Message.UpdatedIncidents({ orgId, incidents: [] })).model
		const late = pageUpdate(synced, Message.FailedLoadIncidents({ orgId }))
		expect(AsyncData.isSuccess(late.model.incidents)).toBe(true)
	})

	test("loaded rows render grouped by environment with the footer tally", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([row("checkout"), row("cart", "staging")])),
			themeResolved(),
			Mount.resolve(MountTable, Message.PaintedTable()),
			expectView(role("table", { name: "Services" })).toExist(),
			expectView(text("checkout")).toExist(),
			expectView(text("Showing 2 services")).toExist(),
			expectView(text("Couldn't load alert status")).toBeAbsent(),
		)
	})

	test("ticking an environment writes it to the URL search", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([row("checkout")])),
			themeResolved(),
			Mount.resolve(MountTable, Message.PaintedTable()),
			click(role("checkbox", { name: "production" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/services?environments=%5B%22production%22%5D",
					isReplace: false,
				}),
			),
		)
	})

	test("the grouping switch writes groupBy and a row click opens the service in its environment", () => {
		const model = loaded([row("checkout", "production", "shop")])
		const grouped = pageUpdate(model, Message.ClickedGroupBy({ groupBy: "environment" }))
		expect(grouped.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/services?groupBy=environment", isReplace: false }),
		)
		const opened = pageUpdate(
			model,
			Message.ClickedServiceRow({ serviceName: "checkout", environment: "production" }),
		)
		expect(opened.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/services/checkout?environments=%5B%22production%22%5D",
				isReplace: false,
			}),
		)
	})

	test("an empty org shows a skeleton until presence is known, never the 'No services found' copy", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("LoadSignalPresence")
		scene(
			{ update: pageUpdate, view },
			given(loaded([])),
			themeResolved(),
			Mount.resolve(MountTable, Message.PaintedTable()),
			expectView(text("No services found")).not.toExist(),
			expectView(label("Loading")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPresence(loaded([]), "absent")),
			themeResolved(),
			Mount.resolve(MountTable, Message.PaintedTable()),
			expectView(text("No services yet")).toExist(),
			expectView(role("link", { name: "Set up tracing" })).toHaveAttr("href", "/settings/ingestion"),
		)
	})

	test("Reload re-resolves the window unsnapped and spins for the reload", () => {
		const reloaded = pageUpdate(loaded([row("checkout")]), Message.ClickedReload())
		expect(names(reloaded.commands)).toEqual(
			expect.arrayContaining(["ResolveServicesWindow", "CompleteServicesReloadSpin"]),
		)
		expect(reloaded.model.isReloading).toBe(true)
		const settled = pageUpdate(
			reloaded.model,
			Message.CompletedReloadSpin({ version: reloaded.model.refreshVersion }),
		)
		expect(settled.model.isReloading).toBe(false)
	})

	test("after a Reload, a grouping change keeps the window and refetches nothing", () => {
		const reloaded = pageUpdate(loaded([row("checkout")]), Message.ClickedReload()).model
		const settled = pageUpdate(
			reloaded,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Refresh" }),
		).model
		const regrouped = routeChanged(settled, { search: { groupBy: "environment" } }, context)
		expect(names(regrouped.commands)).not.toContain("ResolveServicesWindow")
		expect(regrouped.model.overview.key).toBe(settled.overview.key)
	})

	test("a window change re-resolves the clock", () => {
		const changed = routeChanged(windowed(), { search: { timePreset: "1h" } }, context)
		expect(names(changed.commands)).toEqual(["ResolveServicesWindow"])
	})

	test("a service link click navigates once, pushing history", () => {
		const opened = pageUpdate(
			loaded([row("checkout")]),
			Message.ClickedServiceLink({ url: "/services/checkout" }),
		)
		expect(opened.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/services/checkout", isReplace: false }),
		)
	})
})

describe("services list keys", () => {
	const press = (key: string) => Subscription.emit(Message.PressedListKey({ key }))
	const scrolled = () => Command.resolve(ScrollFocusedRow, Message.CompletedScrollFocusedRow())
	const focusedRow = selector("tr[data-focused]")
	// Below `md` the same rows draw as a list of links; it marks the same one.
	const focusedListRow = selector("a[data-focused]")
	// Grouped by environment, production first: checkout, then the staging cart.
	const rows = [row("cart", "staging"), row("checkout")]

	test("J and K move the focus through the rows in the table's order, and Escape clears it", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(rows)),
			themeResolved(),
			Mount.resolve(MountTable, Message.PaintedTable()),
			expectView(focusedRow).toBeAbsent(),
			press("j"),
			scrolled(),
			expectView(focusedRow).toContainText("checkout"),
			expectView(focusedListRow).toContainText("checkout"),
			press("ArrowDown"),
			scrolled(),
			expectView(focusedRow).toContainText("cart"),
			expectView(focusedListRow).toContainText("cart"),
			press("j"),
			scrolled(),
			expectView(focusedRow).toContainText("cart"),
			press("k"),
			scrolled(),
			expectView(focusedRow).toContainText("checkout"),
			press("Escape"),
			expectView(focusedRow).toBeAbsent(),
			expectView(focusedListRow).toBeAbsent(),
		)
	})

	test("Enter opens the focused service as a click on its row does", () => {
		const focused = pageUpdate(loaded(rows), Message.PressedListKey({ key: "j" })).model
		const clicked = pageUpdate(
			focused,
			Message.ClickedServiceRow({ serviceName: "checkout", environment: "production" }),
		)
		const entered = pageUpdate(focused, Message.PressedListKey({ key: "Enter" }))
		expect(entered.outMessage).toEqual(clicked.outMessage)
		expect(entered.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/services/checkout?environments=%5B%22production%22%5D",
				isReplace: false,
			}),
		)
	})

	test("Enter with no focused row opens nothing", () => {
		expect(pageUpdate(loaded(rows), Message.PressedListKey({ key: "Enter" })).outMessage).toBeUndefined()
	})

	test("a new filter starts the focus over", () => {
		const focused = pageUpdate(loaded(rows), Message.PressedListKey({ key: "j" })).model
		const filtered = routeChanged(focused, { search: { environments: ["staging"] } }, context).model
		expect(filtered.focusedIndex).toBeNull()
	})

	describe("hovering a sparkline", () => {
		const BUCKETS = ["2026-10-01 00:00:00", "2026-10-01 01:00:00", "2026-10-01 02:00:00"]
		const series = { buckets: BUCKETS, throughput: [0.5, 2, 1], errorRate: [0, 0.25, 0] }
		/** The pointer on point 1 of a row's sparkline, as its Mount reports it. */
		const hover = (slotId: string) =>
			Message.GotSparklineMessage({
				slotId,
				message: Chart.Message.ChangedChartFocus({ maybeKey: Option.some("1") }),
			})
		/** Painted, with each row's two sparklines (error rate, throughput) mounted. */
		const ready = (model: Model, rows = 1) => [
			given(model),
			themeResolved(),
			Mount.resolve(MountTable, Message.PaintedTable()),
			...Arr.makeBy(rows * 2, () => Mount.resolve(MountSparkline, Chart.Message.CompletedMountChart())),
		]
		const hoveredTime = Option.getOrThrow(hoveredPointLabel(BUCKETS, 1, "UTC"))

		test("a service's only row shows the hovered point's throughput, error rate and time", () => {
			const model = loaded([row("checkout")], { checkout: series })
			const thr = pageUpdate(model, hover("thr-/production/checkout--production")).model
			scene(
				{ update: pageUpdate, view },
				...ready(thr),
				expectView(text(formatThroughput(2, "/s"))).toExist(),
				expectView(text(hoveredTime)).toExist(),
			)
			const err = pageUpdate(model, hover("err-/production/checkout--production")).model
			scene(
				{ update: pageUpdate, view },
				...ready(err),
				expectView(text(formatErrorRate(0.25))).toExist(),
			)
		})

		test("a service listed in two environments keeps each row's own throughput", () => {
			const model = loaded([{ ...row("checkout"), throughput: 7 }, row("checkout", "staging")], {
				checkout: series,
			})
			const hovered = pageUpdate(model, hover("thr-/production/checkout--production")).model
			scene(
				{ update: pageUpdate, view },
				...ready(hovered, 2),
				expectView(text(formatThroughput(7, "/s"))).toExist(),
				expectView(text(formatThroughput(2, "/s"))).toBeAbsent(),
				expectView(text(hoveredTime)).toBeAbsent(),
			)
		})

		test("a sampled row keeps its weighted error rate", () => {
			const model = loaded([{ ...row("checkout"), hasSampling: true, errorRate: 0.01 }], {
				checkout: series,
			})
			const hovered = pageUpdate(model, hover("err-/production/checkout--production")).model
			scene(
				{ update: pageUpdate, view },
				...ready(hovered),
				expectView(text(formatErrorRate(0.01))).toExist(),
				expectView(text(formatErrorRate(0.25))).toBeAbsent(),
			)
		})

		test("leaving the sparkline puts the row's value back", () => {
			const model = loaded([{ ...row("checkout"), throughput: 7 }], { checkout: series })
			const slotId = "thr-/production/checkout--production"
			const hovered = pageUpdate(model, hover(slotId)).model
			const left = pageUpdate(
				hovered,
				Message.GotSparklineMessage({
					slotId,
					message: Chart.Message.ChangedChartFocus({ maybeKey: Option.none() }),
				}),
			).model
			scene(
				{ update: pageUpdate, view },
				...ready(left),
				expectView(text(formatThroughput(7, "/s"))).toExist(),
			)
		})
	})

	test("the release facet names deploy commits by subject, newest first, from the table's lookup", () => {
		const older = Str.repeat(40)("a")
		const newer = Str.repeat(40)("b")
		const unresolved = Str.repeat(40)("c")
		const base = loaded([row("checkout")])
		const withFacets = pageUpdate(
			base,
			Message.CompletedFetchFacets({
				key: base.facets.key ?? "",
				result: Result.succeed({
					environments: [{ name: "production", count: 10 }],
					namespaces: [],
					commitShas: [
						{ name: unresolved, count: 900 },
						{ name: older, count: 500 },
						{ name: newer, count: 100 },
					],
				}),
			}),
		).model
		const painted = pageUpdate(withFacets, Message.PaintedTable())
		const lookup = Arr.findFirst(painted.commands ?? [], ({ name }) => name === FetchCommitSummaries.name)
		expect(Option.getOrUndefined(lookup)?.args).toMatchObject({ shas: `${older},${newer},${unresolved}` })
		const resolved = pageUpdate(
			painted.model,
			Message.CompletedFetchCommitSummaries({
				key: painted.model.commitSummaries.key ?? "",
				result: Result.succeed({
					[older]: { subject: "fix: retry checkout", committedAt: 1000 },
					[newer]: { subject: "feat: express pay", committedAt: 2000 },
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(resolved),
			themeResolved(),
			Mount.resolve(MountTable, Message.PaintedTable()),
			expectView(text("Release")).toExist(),
			expectView(role("checkbox", { name: "feat: express pay" })).toExist(),
			expectView(role("checkbox", { name: "fix: retry checkout" })).toExist(),
			expectView(role("checkbox", { name: "ccccccc" })).toExist(),
		)
	})

	test("a table that paints before the facets land waits for them, then sends one commit lookup", () => {
		const deploySha = Str.repeat(40)("d")
		const facetSha = Str.repeat(40)("e")
		const base = windowed()
		const deployedRow: ServiceRow = {
			...row("checkout"),
			commits: [
				{
					commitSha: deploySha,
					spanCount: 100,
					percentage: 100,
					errorCount: 0,
					firstSeen: "2026-10-01 08:00:00",
				},
			],
		}
		const steps: ReadonlyArray<Message> = [
			Message.CompletedFetchOverview({
				key: base.overview.key ?? "",
				result: Result.succeed([deployedRow]),
			}),
			Message.CompletedFetchSparklines({ key: base.sparklines.key ?? "", result: Result.succeed({}) }),
			Message.CompletedFetchAnomalies({ key: base.anomalies.key ?? "", result: Result.succeed([]) }),
			Message.UpdatedIncidents({ orgId, incidents: [] }),
		]
		const ready = Arr.reduce(steps, base, (model, message) => pageUpdate(model, message).model)
		const painted = pageUpdate(ready, Message.PaintedTable())
		expect(names(painted.commands)).not.toContain(FetchCommitSummaries.name)
		const withFacets = pageUpdate(
			painted.model,
			Message.CompletedFetchFacets({
				key: painted.model.facets.key ?? "",
				result: Result.succeed({
					environments: [],
					namespaces: [],
					commitShas: [{ name: facetSha, count: 5 }],
				}),
			}),
		)
		const lookups = Arr.filter(
			withFacets.commands ?? [],
			({ name }) => name === FetchCommitSummaries.name,
		)
		expect(Arr.map(lookups, (command) => command.args)).toMatchObject([
			{ shas: `${deploySha},${facetSha}` },
		])
	})
})
