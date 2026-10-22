import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import * as Frame from "../../kit/frame"
import { LinkedCursorMessage, MountLinkedCursor } from "../../../../charts/linked-cursor"
import { Message } from "./message"
import type { HostSummary, Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 11:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 11:05:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
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

const resolved = (model: Model, at = window) =>
	pageUpdate(
		model,
		Message.GotFrameMessage({ message: Frame.Message.CompletedResolveWindow({ window: at, nowMs: NOW, locale: "en-US", mode: "Load" }) }),
	)

describe("host detail", () => {
	test("the window fetches the summary and one series per metric strip", () => {
		const entered = init(route, context)
		const names = (resolved(entered.model).commands ?? []).map(({ name }) => name)
		expect(names.filter((name) => name === "FetchInfraHostSummary")).toHaveLength(1)
		expect(names.filter((name) => name === "FetchInfraHostSeries")).toHaveLength(5)
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
			Message.CompletedFetchSummary({ key: windowed.summary.key ?? "", result: Result.succeed(summary) }),
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
		scene({ update: pageUpdate, view }, given(empty), ...mounted(), expectView(text("Show last 7 days")).toExist())
		expect(pageUpdate(empty, Message.ClickedWidenRange()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/hosts/ip-10-0-12-84?timePreset=7d",
				isReplace: false,
			}),
		)
	})
})
