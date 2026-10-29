import { OrgId } from "@maple/domain"
import { Option, Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { Command, given as givenStory, message, model as expectModel, story } from "foldkit/story"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import * as Frame from "../../kit/frame"
import { LinkedCursorMessage, MountLinkedCursor } from "../../../../charts/linked-cursor"
import { HostDetailBlock } from "./block"
import { FetchSeries, FetchSummary, RelayResolvedWindow } from "./command"
import { type HostMetric, Message } from "./message"
import type { HostSummary, Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 11:05:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

/** Every Message the page's graph accepts: its own and its children's generated delivery. */
type PageMessage = typeof HostDetailBlock.Message.Type
const pageUpdate = (model: Model, message: PageMessage) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const route = { hostName: "ip-10-0-12-84", search: {} }

const summary: NonNullable<HostSummary> = {
	hostName: "ip-10-0-12-84",
	osType: "linux",
	hostArch: "amd64",
	cloudProvider: "aws",
	cloudRegion: "us-east-1",
	firstSeen: "2026-10-01 11:00:00",
	lastSeen: "2026-10-01 12:00:00",
	cpuPct: 0.26,
	memoryPct: 0.47,
	diskPct: 0.31,
	load15: 0.69,
}

/** The page root reads theme colours and the metrics panel wires the linked cursor. */
const mounted = () => [
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} })),
	Mount.resolve(MountLinkedCursor, LinkedCursorMessage.CompletedMountLinkedCursor()),
]

const emptySeries = (metric: HostMetric) =>
	Message.CompletedFetchSeries({ metric, key: "", result: Result.succeed({ rows: [], unit: "percent" }) })

/** The frame has resolved `at` (its own behaviour is the kit's), and relayed it back to the page. */
const resolved = (model: Model, at = window) =>
	pageUpdate(
		{ ...model, frame: { ...model.frame, window: at, nowMs: NOW } },
		Message.ResolvedFrameWindow({ mode: "Load" }),
	)

describe("host detail", () => {
	test("the window fetches the summary and one series per metric strip", () => {
		const entered = init(route, context)
		const isFrameResolve = Command.argsOf(Frame.ResolveWindow)
		expect(
			(entered.commands ?? []).filter((command) => Option.isSome(isFrameResolve(command))),
		).toHaveLength(1)
		const names = (resolved(entered.model).commands ?? []).map(({ name }) => name)
		expect(names.filter((name) => name === FetchSummary.name)).toHaveLength(1)
		expect(names.filter((name) => name === FetchSeries.name)).toHaveLength(5)
	})

	test("a window the frame resolves is relayed back and requests the page data", () => {
		story(
			pageUpdate,
			givenStory(init(route, context).model),
			message(Message.InformedOfRouteChange({ search: { timePreset: "6h" } })),
			Command.resolve(
				Frame.ResolveWindow,
				Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "en-US", mode: "Load" }),
			),
			Command.resolve(RelayResolvedWindow, Message.ResolvedFrameWindow({ mode: "Load" })),
			expectModel((requested: Model) => expect(Object.keys(requested.series)).toHaveLength(5)),
			Command.resolveAllExact(
				[FetchSummary, Message.CompletedFetchSummary({ key: "", result: Result.succeed(null) })],
				[FetchSeries, emptySeries("cpu")],
				[FetchSeries, emptySeries("memory")],
				[FetchSeries, emptySeries("filesystem")],
				[FetchSeries, emptySeries("network")],
				[FetchSeries, emptySeries("load15")],
			),
		)
	})

	test("a series answer for a superseded window is dropped", () => {
		const first = resolved(init(route, context).model).model
		const second = resolved(first, later).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchSeries({
				metric: "cpu",
				key: first.series.cpu?.key ?? "",
				result: Result.succeed({ rows: [], unit: "percent" }),
			}),
		)
		expect(late.model.series.cpu).toEqual(second.series.cpu)
	})

	test("the loaded summary renders the hero and the rail", () => {
		const windowed = resolved(init(route, context).model).model
		const loaded = pageUpdate(
			windowed,
			Message.CompletedFetchSummary({
				key: windowed.summary.key ?? "",
				result: Result.succeed(summary),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			...mounted(),
			expectView(text("warn ≥ 80%")).toExist(),
			expectView(text("Resource attributes")).toExist(),
		)
	})

	test("a host with no data offers to widen the range to the last 7 days", () => {
		const windowed = resolved(init(route, context).model).model
		const empty = pageUpdate(
			windowed,
			Message.CompletedFetchSummary({ key: windowed.summary.key ?? "", result: Result.succeed(null) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(empty),
			...mounted(),
			expectView(text("Show last 7 days")).toExist(),
		)
		expect(pageUpdate(empty, Message.ClickedWidenRange()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/hosts/ip-10-0-12-84?timePreset=7d",
				isReplace: false,
			}),
		)
	})
})
