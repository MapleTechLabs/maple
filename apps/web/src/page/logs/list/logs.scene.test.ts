import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import {
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	placeholder,
	role,
	scene,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Chart from "../../../charts/chart"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import * as LogsStream from "../../../ui/logs/logs-stream"
import { VirtualizeLogStream } from "../../../ui/logs/virtualize"
import { PageOutMessage, type PageContext } from "../../contract"
import {
	FetchAttributeKeys,
	FetchFacets,
	FetchFirstPage,
	FetchNextPage,
	FetchVolume,
	MountFilterRail,
	WaitSearchDebounce,
} from "./command"
import { listInput } from "./derive"
import { Message } from "./message"
import type { LogRowSchema, Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const log = (index: number): LogRowSchema => ({
	timestamp: `2026-10-01T11:${String(59 - (index % 60)).padStart(2, "0")}:00.000Z`,
	exactTimestamp: `2026-10-01 11:${String(59 - (index % 60)).padStart(2, "0")}:00.000000000`,
	severityText: index % 10 === 0 ? "WARN" : "INFO",
	severityNumber: 9,
	serviceName: "checkout",
	body: `GET /cart/${index} 200`,
	traceId: undefined,
	spanId: undefined,
	logAttributes: {},
	resourceAttributes: {},
})

const page = (from: number, count: number, cursor: string | null) => ({
	logs: Array.from({ length: count }, (_, i) => log(from + i)),
	cursor,
})

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

/** Entered and windowed: every query in flight. */
const windowed = (search = {}): Model => {
	const entered = init({ search }, context).model
	return pageUpdate(
		pageUpdate(entered, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })).model,
		Message.MountedFilterRail(),
	).model
}

/** The first page has arrived (100 rows and a cursor, so more pages exist). */
const withFirstPage = (): Model =>
	pageUpdate(
		windowed(),
		Message.CompletedFetchFirstPage({
			key: windowed().firstPage.key ?? "",
			result: Result.succeed(page(0, 100, "cursor-1")),
		}),
	).model

/** The virtualizer reports rows `from..to` at 37px (the stream's own Message, as its Mount sends it). */
const streamWindow = (from: number, to: number) =>
	LogsStream.Message.ChangedVirtualWindow({
		rows: Array.from({ length: to - from + 1 }, (_, i) => ({
			index: from + i,
			start: (from + i) * 37,
		})),
		totalSize: 100 * 37,
	})

const windowOf = (from: number, to: number) => Message.GotStreamMessage({ message: streamWindow(from, to) })

describe("logs list", () => {
	test("entry resolves the window, asks the first page, volume and keys, and the facets once the rail mounts", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("ResolveLogsWindow")
		const resolved = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual(expect.arrayContaining([FetchFirstPage.name, FetchVolume.name, FetchAttributeKeys.name]))
		const mounted = pageUpdate(resolved.model, Message.MountedFilterRail())
		expect(names(mounted.commands)).toEqual([FetchFacets.name])
		expect(names(pageUpdate(mounted.model, Message.MountedFilterRail()).commands)).toEqual([])
		expect(resolved.model.firstPage.key).toBe(
			requestKey(orgId, "listLogs", { data: listInput({}, window, null) }),
		)
	})

	test("the org namespace pin overrides the URL's namespace filters in the request", () => {
		const input = listInput({ namespaces: ["a"], excludedNamespaces: ["b"] }, window, "shop")
		expect(input.namespaces).toEqual(["shop"])
		expect(input.excludedNamespaces).toBeUndefined()
	})

	test("a first page for a superseded window is dropped", () => {
		const first = windowed()
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Load" }),
		)
		const late = pageUpdate(
			second.model,
			Message.CompletedFetchFirstPage({
				key: first.firstPage.key ?? "",
				result: Result.succeed(page(0, 3, null)),
			}),
		)
		expect(late.model.firstPage).toEqual(second.model.firstPage)
		expect(late.model.stream.rows).toHaveLength(0)
	})

	test("reaching the end of the window fetches the next page once, and appends it", () => {
		const loaded = withFirstPage()
		expect(names(pageUpdate(loaded, windowOf(0, 40)).commands)).toEqual([])
		const nearEnd = pageUpdate(loaded, windowOf(60, 85))
		expect(names(nearEnd.commands)).toEqual([FetchNextPage.name])
		expect(names(pageUpdate(nearEnd.model, windowOf(61, 86)).commands)).toEqual([])
		const appended = pageUpdate(
			nearEnd.model,
			Message.CompletedFetchNextPage({
				key: loaded.firstPage.key ?? "",
				generation: nearEnd.model.pagination.generation,
				result: Result.succeed(page(100, 100, null)),
			}),
		)
		expect(appended.model.stream.rows).toHaveLength(200)
		expect(appended.model.pagination.isFetching).toBe(false)
	})

	test("a later page started under an older first page is dropped", () => {
		const nearEnd = pageUpdate(withFirstPage(), windowOf(60, 85)).model
		const reloaded = pageUpdate(
			nearEnd,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Refresh" }),
		)
		const stale = pageUpdate(
			reloaded.model,
			Message.CompletedFetchNextPage({
				key: nearEnd.firstPage.key ?? "",
				generation: nearEnd.pagination.generation,
				result: Result.succeed(page(100, 100, null)),
			}),
		)
		expect(stale.model.pagination.pages).toHaveLength(0)
	})

	test("rows render with the footer saying more are available", () => {
		scene(
			{ update: pageUpdate, view },
			given(withFirstPage()),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			Mount.resolve(VirtualizeLogStream, streamWindow(0, 20)),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			expectView(role("log")).toExist(),
			expectView(text("GET /cart/3 200")).toExist(),
			expectView(text("Showing 100 logs, more available")).toExist(),
		)
	})

	test("a failed volume query shows its failure instead of vanishing", () => {
		const base = windowed()
		const model = pageUpdate(
			base,
			Message.CompletedFetchVolume({
				key: base.volume.key ?? "",
				result: Result.fail(toLoadFailure("volume store down")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text(toLoadFailure("volume store down").message)).toExist(),
		)
	})

	test("a workspace that never sent logs sees setup before the first page answers", () => {
		const model = pageUpdate(
			windowed(),
			Message.CompletedLoadSignalPresence({
				result: Result.succeed({ logs: { status: "absent", lastSeenMs: null } }),
			}),
		).model
		expect(names(init({ search: {} }, context).commands)).toContain("LoadLogsSignalPresence")
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text("No logs yet")).toExist(),
		)
	})

	test("an empty volume strip labels its axis in the locale read on entry", () => {
		const base = pageUpdate(windowed(), Message.CompletedReadPreferences({ wrap: false, density: "comfortable", locale: "de-DE" })).model
		const model = pageUpdate(base, Message.CompletedFetchVolume({ key: base.volume.key ?? "", result: Result.succeed([]) })).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			expectView(text("06:00")).toExist(),
		)
	})

	test("ticking a severity writes it to the URL search", () => {
		const model = pageUpdate(
			withFirstPage(),
			Message.ToggledFacetOption({ facet: "severities", name: "WARN" }),
		)
		expect(model.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/logs?severities=%5B%22WARN%22%5D",
				isReplace: false,
			}),
		)
	})

	test("a pasted trace id becomes the trace scope after the debounce", () => {
		const traceId = "4b1f2c3d4e5f60718293a4b5c6d7e8f9"
		const base = withFirstPage()
		const facets = {
			services: [],
			severities: [{ name: "INFO", count: 3 }],
			deploymentEnvs: [],
			namespaces: [],
		}
		const withFacets = pageUpdate(
			base,
			Message.CompletedFetchFacets({ key: base.facets.key ?? "", result: Result.succeed(facets) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(withFacets),
			Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
			Mount.resolve(VirtualizeLogStream, streamWindow(0, 20)),
			Mount.resolve(MountFilterRail, Message.MountedFilterRail()),
			type(placeholder("Text or trace id"), traceId),
			Command.resolve(WaitSearchDebounce, Message.ElapsedSearchDebounce({ generation: 1 })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({ url: `/logs?traceId=${traceId}`, isReplace: false }),
			),
		)
	})

	test("Reload re-resolves the window unsnapped and spins for the reload", () => {
		const reloaded = pageUpdate(withFirstPage(), Message.ClickedReload())
		expect(names(reloaded.commands)).toEqual(
			expect.arrayContaining(["ResolveLogsWindow", "CompleteLogsReloadSpin"]),
		)
		expect(reloaded.model.isReloading).toBe(true)
	})

	test("after a Reload a severity filter reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(withFirstPage(), Message.ClickedReload()).model
		const filtered = routeChanged(reloaded, { search: { severities: ["ERROR"] } }, context)
		expect(names(filtered.commands)).not.toContain("ResolveLogsWindow")
		expect(filtered.commands?.[0]?.args).toMatchObject({ window, search: { severities: ["ERROR"] } })
		const moved = routeChanged(filtered.model, { search: { severities: ["ERROR"], timePreset: "1h" } }, context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([["ResolveLogsWindow", "Refresh"]])
	})

	test("dragging across the volume bars zooms to those buckets, as a replace", () => {
		const base = windowed({ timePreset: "1h" })
		const buckets = ["11:00", "11:05", "11:10"].map((t) => ({ bucket: `2026-10-01 ${t}:00`, counts: { INFO: 4 } }))
		const loaded = pageUpdate(
			base,
			Message.CompletedFetchVolume({ key: base.volume.key ?? "", result: Result.succeed(buckets) }),
		).model
		const focus = (key: string) =>
			Message.GotVolumeChartMessage({ message: Chart.Message.ChangedChartFocus({ maybeKey: Option.some(key) }) })
		const pressed = [focus(buckets[0].bucket), Message.PressedVolumeChart(), focus(buckets[1].bucket)].reduce(
			(model, message) => pageUpdate(model, message).model,
			loaded,
		)
		expect(pressed.volumeBrush).toEqual({ left: buckets[0].bucket, right: buckets[1].bucket, isSelecting: true })
		const released = pageUpdate(pressed, Message.ReleasedVolumeChart())
		expect(released.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/logs?startTime=2026-10-01+11%3A00%3A00&endTime=2026-10-01+11%3A10%3A00",
				isReplace: true,
			}),
		)
		expect(released.model.volumeBrush.isSelecting).toBe(false)
		// A click without a drag does not zoom.
		const clicked = pageUpdate(released.model, Message.PressedVolumeChart()).model
		expect(pageUpdate(clicked, Message.ReleasedVolumeChart()).outMessage).toBeUndefined()
	})
})
