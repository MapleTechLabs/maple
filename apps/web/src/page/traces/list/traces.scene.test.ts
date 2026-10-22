import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, label, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage, type PageContext } from "../../contract"
import { FetchFacets, FetchFirstPage, FetchNextPage, MountPeekRows } from "./command"
import { Message } from "./message"
import type { Model, TraceRow, TracesFacets, TracesPage } from "./model"
import { allRows, contextChanged, init, routeChanged, update } from "./update"
import { view as pageView } from "./view"
import { VirtualizeTraces } from "./virtualize"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const trace = (traceId: string): TraceRow => ({
	traceId,
	spanId: `${traceId}-root`,
	isRootSpan: true,
	startTime: "2026-10-01 11:59:00",
	durationMs: 120,
	spanCount: 4,
	services: ["storefront"],
	rootSpanName: "GET /cart",
	rootName: "GET /cart",
	rootKind: "Server",
	rootAttributes: {},
	httpStatusCode: 200,
	hasError: false,
})

const page = (count: number, scannedCount = count): TracesPage => ({
	rows: Array.from({ length: count }, (_, i) => trace(`trace${String(i).padStart(4, "0")}`)),
	scannedCount,
	hiddenCount: 0,
})

const facets: TracesFacets = {
	services: [{ name: "storefront", count: 10 }],
	spanNames: [],
	httpMethods: [],
	httpStatusCodes: [],
	deploymentEnvs: [{ name: "production", count: 10 }],
	namespaces: [],
	errorCount: 2,
	durationStats: { minDurationMs: 1, maxDurationMs: 900, p50DurationMs: 40, p95DurationMs: 350 },
}

const windowed = (search = {}): Model =>
	pageUpdate(
		init({ search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load", timeZone: "UTC" }),
	).model

const loaded = (first: TracesPage): Model => {
	const base = windowed()
	return [
		Message.CompletedFetchFacets({ key: base.facets.key ?? "", result: Result.succeed(facets) }),
		Message.CompletedFetchFirstPage({ key: base.firstPage.key ?? "", result: Result.succeed(first) }),
	].reduce((model, message) => pageUpdate(model, message).model, base)
}

const withPresence = (model: Model, status: "present" | "absent"): Model =>
	pageUpdate(
		model,
		Message.CompletedLoadSignalPresence({
			result: Result.succeed({ traces: { status, lastSeenMs: null } }),
		}),
	).model

const windowOver = (from: number, to: number) =>
	Message.ChangedVirtualWindow({
		rows: Array.from({ length: to - from }, (_, i) => ({
			index: from + i,
			start: (from + i) * 44,
			end: (from + i + 1) * 44,
		})),
		totalSize: 100 * 44,
	})

describe("traces list", () => {
	test("entry resolves the window, then asks for the facets and the first page", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("ResolveTracesWindow")
		const resolved = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load", timeZone: "UTC" }),
		)
		expect(names(resolved.commands)).toEqual([FetchFacets.name, FetchFirstPage.name])
	})

	test("a first page for a superseded window is dropped", () => {
		const first = windowed()
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Load", timeZone: "UTC" }),
		)
		const late = pageUpdate(
			second.model,
			Message.CompletedFetchFirstPage({
				key: first.firstPage.key ?? "",
				result: Result.succeed(page(3)),
			}),
		)
		expect(allRows(late.model)).toEqual([])
	})

	test("the window nearing the end of a full page asks for the next one, once", () => {
		const model = loaded(page(100))
		const quiet = pageUpdate(model, windowOver(0, 30))
		expect(names(quiet.commands)).toEqual([])
		const near = pageUpdate(quiet.model, windowOver(60, 85))
		expect(names(near.commands)).toEqual([FetchNextPage.name])
		const again = pageUpdate(near.model, windowOver(61, 86))
		expect(names(again.commands)).toEqual([])
	})

	test("Reload refreshes the list, not the facets; a revisited filter answers from its cached page", () => {
		const model = loaded(page(3))
		const reloaded = pageUpdate(
			model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Refresh", timeZone: "UTC" }),
		)
		expect(names(reloaded.commands)).toEqual([FetchFirstPage.name])
		const filtered = routeChanged(model, { search: { hasError: true } }, context).model
		const away = pageUpdate(
			filtered,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load", timeZone: "UTC" }),
		)
		const back = routeChanged(away.model, { search: {} }, context).model
		const returned = pageUpdate(
			back,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load", timeZone: "UTC" }),
		)
		expect(names(returned.commands)).toEqual([])
		expect(allRows(returned.model)).toHaveLength(3)
	})

	test("after a Reload a filter reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(loaded(page(3)), Message.ClickedReload()).model
		const filtered = routeChanged(reloaded, { search: { hasError: true } }, context)
		expect(names(filtered.commands)).toEqual([FetchFirstPage.name])
		expect(filtered.model.window).toEqual(window)
		const moved = routeChanged(filtered.model, { search: { hasError: true, timePreset: "1h" } }, context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([
			["ResolveTracesWindow", "Refresh"],
		])
	})

	test("a short first page has no next page, and a failed next page stops pagination", () => {
		expect(names(pageUpdate(loaded(page(40)), windowOver(20, 40)).commands)).toEqual([])
		const asked = pageUpdate(loaded(page(100)), windowOver(70, 95)).model
		const failed = pageUpdate(
			asked,
			Message.CompletedFetchNextPage({
				key: asked.pagination.key ?? "",
				generation: asked.pagination.generation,
				offset: 100,
				result: Result.fail(toLoadFailure("injected")),
			}),
		)
		expect(failed.model.pagination.isStopped).toBe(true)
		expect(names(pageUpdate(failed.model, windowOver(70, 96)).commands)).toEqual([])
	})

	test("a next page answers only its own request: filter A, B, then A again appends page 2 once", () => {
		const resolved = (model: Model) =>
			pageUpdate(
				model,
				Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load", timeZone: "UTC" }),
			).model
		const first = pageUpdate(loaded(page(100)), windowOver(70, 95))
		const [stale] = first.commands ?? []
		const away = resolved(routeChanged(first.model, { search: { hasError: true } }, context).model)
		const back = resolved(routeChanged(away, { search: {} }, context).model)
		const second = pageUpdate(back, windowOver(70, 95))
		const [current] = second.commands ?? []
		expect(names(second.commands)).toEqual([FetchNextPage.name])
		const answer = (command: typeof current) => {
			const args =
				command?.args !== undefined && "generation" in command.args
					? command.args
					: { generation: -1 }
			return Message.CompletedFetchNextPage({
				key: second.model.pagination.key ?? "",
				generation: Number(args.generation),
				offset: 100,
				result: Result.succeed(page(100)),
			})
		}
		const dropped = pageUpdate(second.model, answer(stale)).model
		expect(allRows(dropped)).toHaveLength(100)
		const appended = pageUpdate(dropped, answer(current)).model
		expect(allRows(appended)).toHaveLength(200)
		expect(allRows(pageUpdate(appended, answer(current)).model)).toHaveLength(200)
	})

	test("loaded rows render in the window with the footer tally", () => {
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(loaded(page(3)), windowOver(0, 3)).model),
			Mount.resolve(VirtualizeTraces, windowOver(0, 3)),
			Mount.resolve(MountPeekRows, Message.ClickedPeekRow({ index: 99 })),
			expectView(role("table", { name: "Traces" })).toExist(),
			expectView(role("link", { name: "trace000" })).toHaveAttr(
				"href",
				"/traces/trace0000?t=2026-10-01+11%3A59%3A00",
			),
			expectView(text("3 traces")).toExist(),
		)
	})

	test("a new time zone re-resolves the window; a new pin re-requests the same one", () => {
		const model = loaded(page(3))
		const zoned = contextChanged(model, { ...context, timeZone: "Asia/Tokyo" })
		expect(names(zoned.commands)).toEqual(["ResolveTracesWindow"])
		const pinned = contextChanged(model, { ...context, pinnedNamespace: "shop" })
		expect(names(pinned.commands)).not.toContain("ResolveTracesWindow")
		expect(names(pinned.commands)).toContain(FetchFirstPage.name)
	})

	test("the Duration header sorts descending first, then flips", () => {
		const model = loaded(page(3))
		expect(pageUpdate(model, Message.ClickedSort({ key: "durationMs" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/traces?sortBy=durationMs&sortDir=desc",
				isReplace: false,
			}),
		)
	})

	test("an empty org shows a skeleton until presence is known, never the 'No traces found' copy", () => {
		expect(names(init({ search: {} }, context).commands)).toContain("LoadTracesSignalPresence")
		scene(
			{ update: pageUpdate, view },
			given(loaded(page(0))),
			expectView(text("No traces found")).not.toExist(),
			expectView(label("Loading")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withPresence(loaded(page(0)), "absent")),
			expectView(text("No traces yet")).toExist(),
		)
	})

	test("a workspace that never sent traces sees setup before the list answers", () => {
		scene(
			{ update: pageUpdate, view },
			given(withPresence(windowed(), "absent")),
			expectView(text("No traces yet")).toExist(),
		)
	})
})
