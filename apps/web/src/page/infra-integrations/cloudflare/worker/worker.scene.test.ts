import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../../contract"
import { type Release, Status, type WorkerRow } from "../data"
import { pageOf } from "./derive"
import { Message, type Model } from "./model"
import { init, routeChanged, update } from "./update"
import { ingestPhaseOf } from "../ingest"
import { dataOf } from "../list/derive"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const worker = (accountId: string): WorkerRow => ({
	serviceName: "cloudflare-worker/edge-router",
	accountId,
	scriptName: "edge-router",
	requests: 100,
	errors: 0,
	errorRate: 0,
	subrequests: 0,
	cpuP50Ms: 1,
	cpuP99Ms: 2,
	durationP50Ms: 3,
	durationP99Ms: 4,
})

const release = (commitSha: string, firstSeen: string): Release => ({
	serviceName: "edge-router",
	commitSha,
	firstSeen,
	spanCount: 10,
	errorCount: 2,
})

const windowed = (search: Model["search"] = {}) =>
	pageUpdate(
		init({ scriptName: "edge-router", search }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	)

const loaded = (model: Model, workers: ReadonlyArray<WorkerRow>, releases: ReadonlyArray<Release>) =>
	[
		Message.CompletedFetchWorkers({ key: model.workers.key ?? "", result: Result.succeed(workers) }),
		Message.CompletedFetchReleases({ key: model.releases.key ?? "", result: Result.succeed(releases) }),
	].reduce((next, message) => pageUpdate(next, message).model, model)

describe("cloudflare worker", () => {
	test("after a Reload an account change reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(windowed().model, Message.ClickedReload()).model
		const scoped = routeChanged(reloaded, { scriptName: "edge-router", search: { account: "acct_b" } }, context)
		expect(names(scoped.commands)).not.toContain("ResolveCloudflareWorkerWindow")
		expect(scoped.model.window).toEqual(window)
		const moved = routeChanged(scoped.model, { scriptName: "edge-router", search: { account: "acct_b", timePreset: "1h" } }, context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([["ResolveCloudflareWorkerWindow", "Refresh"]])
	})

	test("the window asks for the detail, the list rollups and the releases of the script", () => {
		expect(names(windowed().commands)).toEqual(
			expect.arrayContaining([
				"FetchCloudflareWorkerDetail",
				"FetchCloudflareWorkerRollups",
				"FetchCloudflareWorkerPlatform",
				"FetchCloudflareWorkerReleases",
			]),
		)
	})

	test("releases trace the Worker; versions first seen after the opening bucket are deploys", () => {
		const data = pageOf(
			loaded(
				windowed().model,
				[worker("acc_a")],
				[
					release("aaaaaaa1111", "2026-10-01T00:00:00.000Z"),
					release("bbbbbbb2222", "2026-10-01T06:00:00.000Z"),
				],
			),
		)
		expect(data.traced).toEqual({ service: "edge-router", spans: 20, errors: 4 })
		expect(data.markers.map((marker) => marker.label)).toEqual(["bbbbbbb"])
		expect(data.currentVersion).toBe("bbbbbbb2222")
	})

	test("a script name shared across accounts drops the releases, which carry no account", () => {
		const data = pageOf(
			loaded(
				windowed({ account: "acc_a" }).model,
				[worker("acc_a"), worker("acc_b")],
				[release("aaaaaaa1111", "2026-10-01T06:00:00.000Z")],
			),
		)
		expect(data.row?.accountId).toBe("acc_a")
		expect(data.traced).toBeNull()
		expect(data.markers).toEqual([])
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
