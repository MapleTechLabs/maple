import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { LinkedCursorMessage, MountLinkedCursor } from "../../../charts/linked-cursor"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import type { PageContext } from "../../contract"
import { toLoadFailure } from "../../../data/load-failure"
import { ReleasesData } from "../list/model"
import { Message } from "./message"
import { type Model, ReleaseDetail } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_parity"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const NOW = Date.UTC(2026, 9, 1, 12)
const window = { startTime: "2026-09-25 00:00:00", endTime: "2026-10-01 12:00:00" }
const HEAD = "b".repeat(40)
const BASE = "a".repeat(40)

const row = (commit: string, firstSeen: string) => ({
	serviceName: "payment-svc",
	environment: "production",
	commitSha: commit,
	firstSeen,
	spanCount: 1000,
	errorCount: 0,
	p50LatencyMs: 10,
	p95LatencyMs: 40,
	p99LatencyMs: 80,
	apdexScore: 1,
})

const data = Schema.decodeUnknownSync(ReleasesData)({
	releases: [row(BASE, "2026-09-30T10:00:00.000Z"), row(HEAD, "2026-10-01T10:00:00.000Z")],
	timeline: [],
	truncated: false,
	startTime: "2026-09-25T00:00:00.000Z",
	endTime: "2026-10-01T12:00:00.000Z",
	bucketSeconds: 3600,
})

const route = (commitSha = HEAD) => ({ _tag: "Release" as const, commitSha, search: {} })

const withReleases = (commitSha = HEAD) => {
	const entered = init(route(commitSha), context).model
	const resolved = pageUpdate(
		entered,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(
		resolved,
		Message.CompletedFetchReleases({ key: resolved.releases.key ?? "", result: Result.succeed(data) }),
	)
}

const FAILURE = toLoadFailure("injected")
const THEME = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const CURSOR = Mount.resolve(MountLinkedCursor, LinkedCursorMessage.CompletedMountLinkedCursor())
const point = (bucket: string) => ({
	bucket,
	throughput: 10,
	tracedThroughput: 10,
	hasSampling: false,
	samplingWeight: 1,
	errorRate: 0,
	p50LatencyMs: 10,
	p95LatencyMs: 40,
	p99LatencyMs: 80,
	apdexScore: 1,
	totalCount: 10,
	partial: false,
})
const detail = Schema.decodeUnknownSync(ReleaseDetail)({
	versions: data.releases,
	timeline: [],
	points: [point("2026-10-01T10:00:00.000Z")],
	baselinePoints: [point("2026-09-30T10:00:00.000Z")],
	errorFingerprints: [{ fingerprintHash: "123", count: 4, firstSeen: "2026-10-01T10:05:00.000Z" }],
	startTime: data.startTime,
	endTime: data.endTime,
	bucketSeconds: 3600,
})

/** The service body once the list answered: `?service=payment-svc`. */
const withService = () => {
	const entered = init(
		{ _tag: "Release", commitSha: HEAD, search: { service: "payment-svc" } },
		context,
	).model
	const resolved = pageUpdate(
		entered,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	return pageUpdate(
		resolved,
		Message.CompletedFetchReleases({ key: resolved.releases.key ?? "", result: Result.succeed(data) }),
	)
}

const withDetail = () => {
	const listed = withService().model
	return pageUpdate(
		listed,
		Message.CompletedFetchDetail({ key: listed.detail.key ?? "", result: Result.succeed(detail) }),
	)
}

describe("release detail", () => {
	test("entry resolves the window and reads the commit; the deploy's changeset and issues follow", () => {
		expect(names(init(route(), context).commands)).toEqual(
			expect.arrayContaining(["ResolveReleaseWindow", "FetchReleaseCommit"]),
		)
		expect(names(withReleases().commands)).toEqual(
			expect.arrayContaining(["FetchReleaseChangeset", "FetchDeployIssues"]),
		)
	})

	test("a sha that served no traffic says so", () => {
		const model = withReleases("c".repeat(40)).model
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text(/served no traffic in this window/)).toExist(),
		)
	})

	test("with ?service= the detail bundle follows the list, then its issues and changeset", () => {
		const listed = withService()
		expect(names(listed.commands)).toContain("FetchReleaseDetail")
		expect(names(withDetail().commands)).toEqual(
			expect.arrayContaining(["FetchReleaseServiceIssues", "FetchReleaseChangeset"]),
		)
	})

	test("the service body compares against the version it replaced and toggles the charted series", () => {
		const model = withDetail().model
		scene(
			{ update: pageUpdate, view },
			given(model),
			THEME,
			CURSOR,
			expectView(text("This version vs. the previous one")).toExist(),
			expectView(text(`Only spans that carried ${HEAD.slice(0, 7)}`)).toExist(),
		)
		const others = pageUpdate(model, Message.ClickedSeries({ series: "others" })).model
		scene(
			{ update: pageUpdate, view },
			given(others),
			THEME,
			CURSOR,
			expectView(
				text(`Only spans that carried ${BASE.slice(0, 7)}, the version it replaced`),
			).toExist(),
		)
	})

	test("a failed detail bundle offers a retry that refetches only the bundle", () => {
		const listed = withService().model
		const failed = pageUpdate(
			listed,
			Message.CompletedFetchDetail({ key: listed.detail.key ?? "", result: Result.fail(FAILURE) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			THEME,
			expectView(text("Failed to load release")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toEqual(["FetchReleaseDetail"])
	})

	test("after a Reload picking a service reads its bundle under the kept window; a new preset re-resolves", () => {
		const reloaded = pageUpdate(withReleases().model, Message.ClickedReload()).model
		const picked = routeChanged(reloaded, { ...route(), search: { service: "payment-svc" } }, context)
		expect(names(picked.commands)).not.toContain("ResolveReleaseWindow")
		expect(names(picked.commands)).toContain("FetchReleaseDetail")
		const moved = routeChanged(
			picked.model,
			{ ...route(), search: { service: "payment-svc", timePreset: "1h" } },
			context,
		)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([
			["ResolveReleaseWindow", "Refresh"],
		])
	})

	test("Reload re-resolves the window unsnapped and spins", () => {
		const reloaded = pageUpdate(withReleases().model, Message.ClickedReload())
		expect(names(reloaded.commands)).toEqual(
			expect.arrayContaining(["ResolveReleaseWindow", "CompleteReleaseReloadSpin"]),
		)
		expect(reloaded.model.isReloading).toBe(true)
	})

	test("the deploy's releases read carries the namespace pin; a pin change re-resolves", () => {
		const pinned: PageContext = { ...context, pinnedNamespace: "payments" }
		const entered = init(route(), pinned).model
		const resolved = update(
			entered,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
			pinned,
		)
		expect(resolved.commands?.[0]?.args).toMatchObject({ namespaces: ["payments"] })
		expect(resolved.model.releases.key).not.toEqual(withReleases().model.releases.key)
		expect(names(contextChanged(withReleases().model, pinned).commands)).toEqual(["ResolveReleaseWindow"])
	})
})
