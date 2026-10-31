import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import { type PageContext, PageOutMessage } from "../../contract"
import { Message } from "./message"
import { ReleasesData, type Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = { orgId: Schema.decodeSync(OrgId)("org_parity"), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const NOW = Date.UTC(2026, 9, 1, 12)
const window = { startTime: "2026-09-25 00:00:00", endTime: "2026-10-01 12:00:00" }

const sha = (digit: string) => digit.repeat(40)
const row = (service: string, commit: string, firstSeen: string, errorCount = 0) => ({
	serviceName: service,
	environment: "production",
	commitSha: commit,
	firstSeen,
	spanCount: 1000,
	errorCount,
	p50LatencyMs: 10,
	p95LatencyMs: 40,
	p99LatencyMs: 80,
	apdexScore: 1,
})

const data = Schema.decodeUnknownSync(ReleasesData)({
	releases: [row("payment-svc", sha("a"), "2026-09-30T10:00:00.000Z"), row("payment-svc", sha("b"), "2026-10-01T10:00:00.000Z", 90)],
	timeline: [],
	truncated: false,
	startTime: "2026-09-25T00:00:00.000Z",
	endTime: "2026-10-01T12:00:00.000Z",
	bucketSeconds: 3600,
})

const loaded = (): Model => {
	const entered = init({ search: {} }, context).model
	const resolved = pageUpdate(entered, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })).model
	return pageUpdate(resolved, Message.CompletedFetchReleases({ key: resolved.releases.key ?? "", result: Result.succeed(data) })).model
}

describe("releases list", () => {
	test("entry resolves the window, then reads the releases for it", () => {
		const entered = init({ search: {} }, context)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining(["ResolveReleasesWindow", "ReadRememberedFilterSections"]),
		)
		const resolved = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual(["FetchReleases"])
	})

	test("the table's reads follow its first paint, keyed on the rows it shows", () => {
		const painted = pageUpdate(loaded(), Message.PaintedTable())
		expect(names(painted.commands)).toEqual(
			expect.arrayContaining(["FetchReleaseIssues", "FetchReleaseRanges", "FetchReleaseCommits"]),
		)
		expect(pageUpdate(painted.model, Message.PaintedTable()).commands ?? []).toHaveLength(0)
	})

	test("a stale answer is dropped; a failure renders the error state", () => {
		const entered = init({ search: {} }, context).model
		const resolved = pageUpdate(entered, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })).model
		expect(pageUpdate(resolved, Message.CompletedFetchReleases({ key: "old", result: Result.succeed(data) })).model.releases).toEqual(resolved.releases)
		const failed = pageUpdate(
			resolved,
			Message.CompletedFetchReleases({ key: resolved.releases.key ?? "", result: Result.fail(toLoadFailure(new Error("down"))) }),
		).model
		scene({ update: pageUpdate, view }, given(failed), expectView(text("Couldn't load releases")).toExist())
	})

	test("after a Reload an environment filter reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(loaded(), Message.ClickedReload()).model
		const filtered = routeChanged(reloaded, { search: { environments: ["production"] } }, context)
		expect(names(filtered.commands)).toEqual(["FetchReleases"])
		expect(filtered.commands?.[0]?.args).toMatchObject({ input: { startTime: window.startTime, environments: ["production"] } })
		const moved = routeChanged(filtered.model, { search: { environments: ["production"], timePreset: "1h" } }, context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([["ResolveReleasesWindow", "Refresh"]])
	})

	test("health is single-select through the URL", () => {
		const model = loaded()
		expect(pageUpdate(model, Message.ToggledHealthOption({ name: "regressed" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/releases?impact=regressed", isReplace: false }),
		)
		const filtered = { ...model, search: { impact: "regressed" as const } }
		expect(pageUpdate(filtered, Message.ToggledHealthOption({ name: "regressed" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/releases", isReplace: false }),
		)
	})

	test("the namespace pin narrows the releases read and its key, and a pin change re-reads", () => {
		const pinned: PageContext = { ...context, pinnedNamespace: "payments" }
		const entered = init({ search: {} }, pinned).model
		const resolved = update(entered, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }), pinned)
		expect(resolved.commands?.[0]?.args).toMatchObject({ input: { namespaces: ["payments"] } })
		expect(resolved.model.releases.key).not.toEqual(loaded().releases.key)
		expect(names(contextChanged(loaded(), pinned).commands)).toEqual(["FetchReleases"])
	})
})
