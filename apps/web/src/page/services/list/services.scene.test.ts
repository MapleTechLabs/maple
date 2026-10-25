import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	label,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ThemeMessage, ResolveThemeColors } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import { PageOutMessage, type PageContext } from "../../contract"
import {
	FetchAnomalies,
	FetchBaseline,
	FetchFacets,
	FetchOverview,
	FetchSparklines,
	MountTable,
} from "./command"
import { Message } from "./message"
import type { Model, ServiceRow } from "./model"
import { init, overviewInput, routeChanged, update } from "./update"
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
	(commands ?? []).map(({ name }) => name)

const overviewKey = (input = overviewInput({}, window, null)) =>
	requestKey(orgId, "getServiceOverview", { data: input })

/** Entered and windowed: every query in flight. */
const windowed = (): Model => {
	const entered = init({ search: {} }, context).model
	return pageUpdate(entered, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })).model
}

/** Everything the table blocks on has loaded, with `rows` and no sparkline series. */
const loaded = (rows: ReadonlyArray<ServiceRow>): Model => {
	const base = windowed()
	const steps: ReadonlyArray<Message> = [
		Message.CompletedFetchOverview({ key: base.overview.key ?? "", result: Result.succeed(rows) }),
		Message.CompletedFetchSparklines({ key: base.sparklines.key ?? "", result: Result.succeed({}) }),
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
	return steps.reduce((model, message) => pageUpdate(model, message).model, base)
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
		expect(names(resolved.commands)).toEqual([
			FetchOverview.name,
			FetchSparklines.name,
			FetchFacets.name,
			FetchBaseline.name,
			FetchAnomalies.name,
		])
		const fetch = resolved.commands?.find(({ name }) => name === FetchOverview.name)
		expect(fetch?.args).toMatchObject({
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
			given(steps.reduce((model, message) => pageUpdate(model, message).model, base)),
			themeResolved(),
			Mount.resolve(MountTable, Message.PaintedTable()),
			expectView(role("table", { name: "Services" })).toExist(),
			expectView(text("checkout")).toExist(),
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
			expectView(role("link", { name: "Set up tracing" })).toHaveAttr(
				"href",
				"/settings?tab=ingestion",
			),
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
