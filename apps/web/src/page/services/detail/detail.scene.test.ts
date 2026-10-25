import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import {
	FetchCommit,
	FetchDependencies,
	FetchEndpoints,
	FetchIssues,
	FetchOperations,
	FetchOverview,
	FetchUsage,
	FetchWorkloads,
} from "./command"
import { LinkedCursorMessage, MountLinkedCursor } from "../../../charts/linked-cursor"
import * as Dialog from "../../../ui/dialog"
import * as PeekMessage from "./endpoint-peek/message"
import { Message } from "./message"
import type { Model, OverviewData } from "./model"
import type { Endpoint, Operation } from "./model-tabs"
import { contextChanged, init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const NOW = Date.parse("2026-10-01T12:00:00Z")
const SHA = "f8f3f66ef8f3f66ef8f3f66ef8f3f66ef8f3f66e"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const route = (search: Model["search"] = {}) => ({ serviceName: "payment-svc", search })

/** Entered with the clock read: every Overview query in flight. */
const entered = (search: Model["search"] = {}): Model => {
	const start = init(route(search), context).model
	return pageUpdate(start, Message.CompletedResolveClock({ nowMs: NOW, mode: "Load" })).model
}

const overviewData = (releases: OverviewData["releases"] = []): OverviewData => ({
	points: [],
	releases,
	environments: ["production"],
})

const release = (commitSha: string, bucket: string) => ({ bucket, commitSha, count: 10, errorCount: 0 })

const operation = (spanName: string, errorRate: number): Operation => ({
	spanName,
	spanCount: 10,
	estimatedSpanCount: 10,
	errorCount: 0,
	estimatedErrorCount: 0,
	errorRate,
	avgDurationMs: 5,
	p50DurationMs: 4,
	p95DurationMs: 9,
	sparkline: [],
})

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

describe("service detail", () => {
	test("entry reads the clock, then asks every Overview read under its key", () => {
		expect(names(init(route(), context).commands)).toContain("ResolveServiceDetailClock")
		const start = init(route(), context).model
		const resolved = pageUpdate(start, Message.CompletedResolveClock({ nowMs: NOW, mode: "Load" }))
		expect(names(resolved.commands)).toEqual([
			FetchOverview.name,
			FetchOperations.name,
			FetchIssues.name,
			FetchUsage.name,
			FetchWorkloads.name,
			FetchDependencies.name,
		])
		expect(resolved.model.window).toEqual({
			startTime: "2026-10-01 00:00:00",
			endTime: "2026-10-01 12:00:00",
		})
	})

	test("a window change resolves against the clock now, not the entry clock", () => {
		const first = entered()
		const changed = routeChanged(first, route({ timePreset: "1h" }), context)
		const later = NOW + 40 * 60_000
		const resolved = pageUpdate(
			changed.model,
			Message.CompletedResolveClock({ nowMs: later, mode: "Load" }),
		)
		expect(resolved.model.window).toEqual({
			startTime: "2026-10-01 11:40:00",
			endTime: "2026-10-01 12:40:00",
		})
	})

	test("a zone change re-reads the clock; a pin change keeps it", () => {
		const first = entered({ timePreset: "today" })
		const pinned = contextChanged(first, { ...context, pinnedNamespace: "shop" })
		expect(names(pinned.commands)).not.toContain("ResolveServiceDetailClock")
		const zoned = contextChanged(first, { ...context, timeZone: "America/New_York" })
		expect(names(zoned.commands)).toEqual(["ResolveServiceDetailClock"])
	})

	test("an overview answer for a superseded window is dropped", () => {
		const first = entered()
		const changed = routeChanged(first, route({ timePreset: "6h" }), context)
		expect(names(changed.commands)).toEqual(["ResolveServiceDetailClock"])
		const second = pageUpdate(
			changed.model,
			Message.CompletedResolveClock({ nowMs: NOW, mode: "Load" }),
		).model
		expect(second.window).toEqual({ startTime: "2026-10-01 06:00:00", endTime: "2026-10-01 12:00:00" })
		const late = pageUpdate(
			second,
			Message.CompletedFetchOverview({
				key: first.overview.key ?? "",
				result: Result.succeed(overviewData()),
			}),
		)
		expect(late.model.overview).toEqual(second.overview)
	})

	test("a loaded overview resolves each deploy's commit once", () => {
		const model = entered()
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchOverview({
				key: model.overview.key ?? "",
				result: Result.succeed(
					overviewData([
						release(SHA, "2026-10-01T10:00:00.000Z"),
						release("v1.2.3", "2026-10-01T02:00:00.000Z"),
					]),
				),
			}),
		)
		expect(names(loaded.commands)).toEqual([FetchCommit.name])
		expect(AsyncData.isLoading(loaded.model.commits[SHA] ?? AsyncData.Idle())).toBe(true)
		const again = pageUpdate(loaded.model, Message.ClickedToggleDeploys())
		expect(names(again.commands)).toEqual([])
	})

	test("a tab click replaces the URL; the API tab then reads its endpoints, KPIs and status codes", () => {
		const model = entered()
		expect(pageUpdate(model, Message.ClickedTab({ tab: "operations" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/services/payment-svc?tab=operations",
				isReplace: true,
			}),
		)
		const api = routeChanged(model, route({ tab: "api" }), context)
		expect(names(api.commands)).toContain(FetchEndpoints.name)
		expect(names(api.commands)).toContain("FetchServiceApiOverview")
		expect(names(api.commands)).toContain("FetchServiceEndpointStatusBreakdown")
	})

	test("the environment switcher scopes the URL, and All environments clears it", () => {
		const model = entered()
		const scoped = pageUpdate(
			model,
			Message.GotEnvironmentSelectMessage({
				message: { _tag: "SelectedItem", index: 1, value: "production" },
			}),
		)
		expect(scoped.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/services/payment-svc?environments=%5B%22production%22%5D",
				isReplace: false,
			}),
		)
		const all = pageUpdate(
			entered({ environments: ["production"] }),
			Message.GotEnvironmentSelectMessage({
				message: { _tag: "SelectedItem", index: 0, value: "all" },
			}),
		)
		expect(all.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/services/payment-svc", isReplace: false }),
		)
	})

	test("an operation row drills into its spans in /traces at span level", () => {
		const opened = pageUpdate(entered(), Message.ClickedOperation({ spanName: "GET /charges" }))
		expect(opened.outMessage?._tag).toBe("RequestedNavigation")
		const url = opened.outMessage?._tag === "RequestedNavigation" ? opened.outMessage.url : ""
		expect(url.startsWith("/traces?")).toBe(true)
		expect(new URLSearchParams(url.slice("/traces?".length)).get("spanNames")).toBe('["GET /charges"]')
		expect(new URLSearchParams(url.slice("/traces?".length)).get("rootOnly")).toBe("false")
	})

	test("a sort header click sorts by that column, a second click flips it", () => {
		const once = pageUpdate(
			entered(),
			Message.ClickedSort({ table: "operations", key: "errorRate" }),
		).model
		expect(once.sorts.operations).toEqual({ key: "errorRate", dir: "desc" })
		const twice = pageUpdate(once, Message.ClickedSort({ table: "operations", key: "errorRate" })).model
		expect(twice.sorts.operations).toEqual({ key: "errorRate", dir: "asc" })
		const path = pageUpdate(entered(), Message.ClickedSort({ table: "endpoints", key: "path" })).model
		expect(path.sorts.endpoints).toEqual({ key: "path", dir: "asc" })
	})
})

const endpoint = (route: string, estimatedSpanCount = 10): Endpoint => ({
	spanName: `GET ${route}`,
	method: "GET",
	route,
	spanCount: 10,
	estimatedSpanCount,
	errorCount: 0,
	estimatedErrorCount: 0,
	errorRate: 0,
	avgDurationMs: 5,
	p50DurationMs: 4,
	p95DurationMs: 9,
	p99DurationMs: 12,
	httpClassifiedSpanCount: 10,
	httpStatusCount: 10,
	http4xxCount: 0,
	http5xxCount: 0,
	requestBodyBytes: 0,
	requestBodyCount: 0,
})

describe("service detail view", () => {
	test("a failed overview replaces the tab with its error and Retry asks again", () => {
		const model = entered()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchOverview({
				key: model.overview.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(text("Couldn't load service overview")).toExist(),
		)
		const retried = pageUpdate(failed, Message.ClickedRetry({ target: "Overview" }))
		expect(names(retried.commands)).toEqual([FetchOverview.name])
	})

	test("clicking a tab link replaces the history entry", () => {
		const model = entered()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchOverview({
				key: model.overview.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			click(role("link", { name: "Operations" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/services/payment-svc?tab=operations",
					isReplace: true,
				}),
			),
		)
	})

	test("the Operations tab sorts by error rate from its header", () => {
		const model = entered({ tab: "operations" })
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchOperations({
				key: model.operations.key ?? "",
				result: Result.succeed([operation("SELECT a", 0), operation("SELECT b", 0.04)]),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			click(role("button", { name: "Errors" })),
			expectView(role("columnheader", { name: "Errors" })).toHaveAttr("aria-sort", "descending"),
		)
	})

	test("more than eight deploys list eight until Show all", () => {
		const model = entered()
		const releases = Array.from({ length: 10 }, (_, index) =>
			release(`v1.0.${index}`, `2026-10-01T0${index}:00:00.000Z`),
		)
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchOverview({
				key: model.overview.key ?? "",
				result: Result.succeed(overviewData(releases)),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			Mount.resolve(MountLinkedCursor, LinkedCursorMessage.CompletedMountLinkedCursor()),
			expectView(text("10 versions")).toExist(),
			expectView(text("v1.0.1")).not.toExist(),
			click(role("button", { name: "Show all 10 deploys" })),
			expectView(text("v1.0.1")).toExist(),
			expectView(role("button", { name: "Show fewer" })).toExist(),
		)
	})

	test("unrouted paths stay collapsed until Show anyway", () => {
		const model = entered({ tab: "api" })
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchEndpoints({
				key: model.endpoints.key ?? "",
				result: Result.succeed([
					endpoint("/users/123456789"),
					endpoint("/users/987654321"),
					endpoint("/health"),
				]),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			expectView(text("Unrouted paths")).toExist(),
			click(role("button", { name: "Show anyway" })),
			expectView(role("button", { name: "Hide" })).toExist(),
		)
	})
})

describe("the API tab's endpoint drawer", () => {
	const loadedApi = (search: Model["search"] = {}) => {
		const model = entered({ tab: "api", ...search })
		return pageUpdate(
			model,
			Message.CompletedFetchEndpoints({
				key: model.endpoints.key ?? "",
				result: Result.succeed([endpoint("/a", 30), endpoint("/b", 20), endpoint("/c", 10)]),
			}),
		)
	}
	const peekMessage = (message: PeekMessage.Message) => Message.GotEndpointPeekMessage({ message })

	test("clicking a row puts its endpoint in the URL", () => {
		const clicked = pageUpdate(loadedApi().model, Message.ClickedEndpoint({ spanName: "GET /b" }))
		expect(clicked.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/services/payment-svc?tab=api&endpoint=GET+%2Fb",
				isReplace: false,
			}),
		)
	})

	test("a peeked endpoint opens the drawer and warms it and both neighbours", () => {
		const loaded = loadedApi({ endpoint: "GET /b" })
		expect(loaded.model.endpointPeek.dialog.isOpen).toBe(true)
		expect(names(loaded.commands).filter((name) => name === "FetchServiceEndpointDetail")).toHaveLength(3)
	})

	test("an endpoint no row matches keeps the drawer closed", () => {
		expect(loadedApi({ endpoint: "GET /gone" }).model.endpointPeek.dialog.isOpen).toBe(false)
	})

	test("a step replaces the endpoint with the next row; closing clears it", () => {
		const { model } = loadedApi({ endpoint: "GET /b" })
		const stepped = pageUpdate(model, peekMessage(PeekMessage.Message.ClickedStep({ step: 1 })))
		expect(stepped.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/services/payment-svc?tab=api&endpoint=GET+%2Fc",
				isReplace: true,
			}),
		)
		const closed = pageUpdate(
			model,
			peekMessage(PeekMessage.Message.GotDialogMessage({ message: Dialog.Message.PressedEscape() })),
		)
		expect(closed.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/services/payment-svc?tab=api", isReplace: true }),
		)
	})

	test("retrying a failed detail reads that endpoint alone again", () => {
		const { model } = loadedApi({ endpoint: "GET /b" })
		const failed = pageUpdate(
			model,
			peekMessage(
				PeekMessage.Message.CompletedFetchDetail({
					spanName: "GET /b",
					key: model.endpointPeek.details["GET /b"]?.key ?? "",
					result: Result.fail(toLoadFailure("boom")),
				}),
			),
		).model
		const retried = pageUpdate(failed, peekMessage(PeekMessage.Message.ClickedRetryDetail()))
		expect(names(retried.commands)).toEqual(["FetchServiceEndpointDetail"])
	})

	test("switching tabs drops the open endpoint from the URL", () => {
		const { model } = loadedApi({ endpoint: "GET /b" })
		const switched = pageUpdate(model, Message.ClickedTab({ tab: "operations" }))
		expect(switched.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/services/payment-svc?tab=operations",
				isReplace: true,
			}),
		)
	})

	test("a Reload re-reads the sparklines over the same rows", () => {
		const { model } = loadedApi()
		const series = pageUpdate(
			model,
			Message.CompletedFetchEndpointSeries({
				key: model.endpointSeries.key ?? "",
				result: Result.succeed([]),
			}),
		).model
		const reloaded = pageUpdate(series, Message.CompletedResolveClock({ nowMs: NOW, mode: "Refresh" }))
		expect(names(reloaded.commands)).toContain("FetchServiceEndpointSeries")
	})

	test("retrying the drawer re-reads a failed tab series its charts come from", () => {
		const { model } = loadedApi({ endpoint: "GET /b" })
		const failed = pageUpdate(
			model,
			Message.CompletedFetchEndpointSeries({
				key: model.endpointSeries.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		).model
		const retried = pageUpdate(failed, peekMessage(PeekMessage.Message.ClickedRetryDetail()))
		expect(names(retried.commands)).toContain("FetchServiceEndpointSeries")
	})

	test("a step past the last row stays put", () => {
		const { model } = loadedApi({ endpoint: "GET /c" })
		expect(
			pageUpdate(model, peekMessage(PeekMessage.Message.ClickedStep({ step: 1 }))).outMessage,
		).toBeUndefined()
	})

	test("an endpoint gone from the settled table leaves the URL instead of lingering", () => {
		const loaded = loadedApi({ endpoint: "GET /gone" })
		expect(loaded.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/services/payment-svc?tab=api", isReplace: true }),
		)
	})

	test("a deep link into the unrouted paths opens that group and the drawer", () => {
		const model = entered({ tab: "api", endpoint: "GET /users/123456789" })
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchEndpoints({
				key: model.endpoints.key ?? "",
				result: Result.succeed([
					endpoint("/users/123456789"),
					endpoint("/users/987654321"),
					endpoint("/health"),
				]),
			}),
		).model
		expect(loaded.expandedEndpointGroups).toEqual(["unrouted"])
		expect(loaded.endpointPeek.dialog.isOpen).toBe(true)
	})

	test("peeking an endpoint outside the sparkline set reads its series alone", () => {
		const model = entered({ tab: "api", endpoint: "GET /users/123456789" })
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchEndpoints({
				key: model.endpoints.key ?? "",
				result: Result.succeed([
					endpoint("/users/123456789"),
					endpoint("/users/987654321"),
					endpoint("/health"),
				]),
			}),
		)
		expect(names(loaded.commands)).toContain("FetchServiceEndpointPeekSeries")
		expect(loaded.model.endpointSeries.key).not.toContain("users")
	})

	test("the Rejecting filter hides endpoints that answered every request below 400", () => {
		const { model } = loadedApi()
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("/a")).toExist(),
			click(role("button", { name: "Rejecting > 5%" })),
			expectView(text("No endpoint matches this filter.")).toExist(),
		)
	})
})
