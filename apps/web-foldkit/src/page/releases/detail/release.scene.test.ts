import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { ReleasesData } from "../list/model"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = { orgId: Schema.decodeSync(OrgId)("org_parity"), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
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
	const resolved = pageUpdate(entered, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })).model
	return pageUpdate(resolved, Message.CompletedFetchReleases({ key: resolved.releases.key ?? "", result: Result.succeed(data) }))
}

describe("release detail", () => {
	test("entry resolves the window and reads the commit; the deploy's changeset and issues follow", () => {
		expect(names(init(route(), context).commands)).toEqual(["ResolveReleaseWindow", "FetchReleaseCommit"])
		expect(names(withReleases().commands)).toEqual(["FetchReleaseChangeset", "FetchDeployIssues"])
	})

	test("a sha that served no traffic says so", () => {
		const model = withReleases("c".repeat(40)).model
		scene({ update: pageUpdate, view }, given(model), expectView(text(/served no traffic in this window/)).toExist())
	})

	test("Reload re-resolves the window unsnapped and spins", () => {
		const reloaded = pageUpdate(withReleases().model, Message.ClickedReload())
		expect(names(reloaded.commands)).toEqual(["ResolveReleaseWindow", "CompleteReleaseReloadSpin"])
		expect(reloaded.model.isReloading).toBe(true)
	})
})
