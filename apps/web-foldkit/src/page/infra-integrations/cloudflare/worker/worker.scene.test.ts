import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../../contract"
import type { Release, WorkerRow } from "../data"
import { pageOf } from "./derive"
import { Message, type Model } from "./model"
import { init, update } from "./update"

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
	test("the window asks for the detail, the list rollups and the releases of the script", () => {
		expect(names(windowed().commands)).toEqual([
			"FetchCloudflareWorkerDetail",
			"FetchCloudflareWorkerRollups",
			"FetchCloudflareWorkerPlatform",
			"FetchCloudflareWorkerReleases",
		])
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
})
