import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import { Status, type ZoneDetail } from "../data"
import { sectionOf } from "./derive"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { ingestPhaseOf } from "../ingest"
import { dataOf } from "../list/derive"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const detail: ZoneDetail = {
	statusBuckets: [{ bucket: "2026-10-01T00:00:00Z", statusClass: "2xx", requests: 900 }],
	cacheBuckets: [],
	latencyBuckets: [],
	ignoredFilters: [],
	latencyIgnoredFilters: [],
}

const windowed = (search: Model["search"] = {}) =>
	pageUpdate(
		init({ zoneName: "acme.test", search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	)

const withDetail = (model: Model) =>
	pageUpdate(
		model,
		Message.CompletedFetchDetail({ key: model.detail.key ?? "", result: Result.succeed(detail) }),
	)

const navigation = (url: string, isReplace = false) => PageOutMessage.RequestedNavigation({ url, isReplace })

describe("cloudflare zone", () => {
	test("the window asks for the facets, signals, DNS, security and the zone rollup", () => {
		expect(names(windowed().commands)).toEqual(
			expect.arrayContaining([
				"FetchCloudflareZoneFacets",
				"FetchCloudflareZoneDetail",
				"FetchCloudflareZoneDns",
				"FetchCloudflareZoneSecurity",
				"FetchCloudflareZoneRollup",
			]),
		)
	})

	test("the breakdown mounts once the detail has rows, and re-asks per dimension", () => {
		const loaded = withDetail(windowed().model)
		expect(names(loaded.commands)).toEqual(["FetchCloudflareZoneBreakdown"])
		const typed = pageUpdate(loaded.model, Message.ChangedBreakdownSearch({ value: "prod" })).model
		const switched = pageUpdate(typed, Message.ClickedDimension({ dimension: "host" }))
		expect(switched.model.breakdownSearch).toBe("")
		expect(names(switched.commands)).toEqual(["FetchCloudflareZoneBreakdown"])
		expect(switched.model.breakdown.key).not.toBe(loaded.model.breakdown.key)
	})

	test("the live lookup runs only on request, and typing returns to the stored rows", () => {
		const loaded = withDetail(windowed().model).model
		const typed = pageUpdate(loaded, Message.ChangedBreakdownSearch({ value: " widget " })).model
		const live = pageUpdate(typed, Message.ClickedSearchLive())
		expect(live.model.liveQuery).toBe("widget")
		expect(names(live.commands)).toEqual(["FetchCloudflareTopTraffic"])
		expect(
			pageUpdate(live.model, Message.ChangedBreakdownSearch({ value: "x" })).model.liveQuery,
		).toBeNull()
	})

	test("a row toggles its value into the page filter; clearing keeps the window and tab", () => {
		const model = windowed({ timePreset: "1d", tab: "dns" }).model
		expect(
			pageUpdate(model, Message.ToggledFilter({ key: "paths", value: "/checkout" })).outMessage,
		).toEqual(
			navigation("/infra/cloudflare/acme.test?paths=%5B%22%2Fcheckout%22%5D&timePreset=1d&tab=dns"),
		)
		const filtered = windowed({ timePreset: "1d", paths: ["/checkout"], hosts: ["acme.test"] }).model
		expect(pageUpdate(filtered, Message.ClickedClearFilters()).outMessage).toEqual(
			navigation("/infra/cloudflare/acme.test?timePreset=1d"),
		)
	})

	test("the tab is written in place, and a tab without its dataset shows traffic", () => {
		const model = windowed().model
		expect(pageUpdate(model, Message.ClickedTab({ tab: "security" })).outMessage).toEqual(
			navigation("/infra/cloudflare/acme.test?tab=security", true),
		)
		expect(sectionOf(windowed({ tab: "security" }).model)).toBe("traffic")
	})

	test("the ingest poll advances the clock, so a silent connection turns stalled", () => {
		const status = Schema.decodeUnknownSync(Status)({
			connected: true,
			accountId: "acc_a",
			accountName: "Acme",
			connectedByUserId: null,
			scope: null,
			analyticsCapable: true,
			connectedAt: 0,
			accounts: [],
			zones: [],
			workers: null,
		})
		const model = windowed().model
		const connected = pageUpdate(
			model,
			Message.CompletedLoadStatus({ key: model.status.key ?? "", result: Result.succeed(status) }),
		).model
		const phase = (m: Model) => ingestPhaseOf(dataOf(m.status.data), dataOf(m.usage.data), m.nowMs)?.kind
		expect(phase(connected)).toBe("discovering")
		const ticked = pageUpdate(connected, Message.TickedIngestPoll({ nowMs: 31 * 60_000 })).model
		expect(phase(ticked)).toBe("stalled")
	})
})
