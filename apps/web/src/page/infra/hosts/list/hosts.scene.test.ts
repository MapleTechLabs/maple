import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../../contract"
import * as Frame from "../../kit/frame"
import { FetchHosts } from "./command"
import { Message } from "./message"
import type { HostRow, Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const host = (hostName: string, cpuPct: number): HostRow => ({
	hostName,
	osType: "linux",
	hostArch: "amd64",
	cloudProvider: "aws",
	lastSeen: "2026-10-01 12:00:00",
	cpuPct,
	memoryPct: 0.2,
	diskPct: 0.2,
	load15: 0.5,
})

const resolved = (model: Model, at = window) =>
	pageUpdate(
		model,
		Message.GotFrameMessage({
			message: Frame.Message.CompletedResolveWindow({
				window: at,
				nowMs: NOW,
				locale: "en-US",
				mode: "Load",
			}),
		}),
	)

const loaded = (hosts: ReadonlyArray<HostRow>, search: Model["search"] = {}): Model => {
	const windowed = resolved(init({ search }, context).model).model
	return pageUpdate(
		windowed,
		Message.CompletedFetchHosts({ key: windowed.hosts.key ?? "", result: Result.succeed(hosts) }),
	).model
}

describe("hosts list", () => {
	test("entry resolves the window and fetches the ingest key; the window then fetches the hosts", () => {
		const entered = init({ search: {} }, context)
		expect((entered.commands ?? []).map(({ name }) => name)).toEqual(
			expect.arrayContaining(["ResolveInfraWindow", "FetchInstallIngestKey"]),
		)
		expect((resolved(entered.model).commands ?? []).map(({ name }) => name)).toContain(FetchHosts.name)
	})

	test("an answer for a superseded window is dropped", () => {
		const first = resolved(init({ search: {} }, context).model).model
		const second = resolved(first, later).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchHosts({ key: first.hosts.key ?? "", result: Result.succeed([]) }),
		)
		expect(late.model.hosts).toEqual(second.hosts)
	})

	test("loaded hosts render busiest first, and a scope cell writes the scope to the URL", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([host("quiet", 0.1), host("busy", 0.7)])),
			expectView(text("2 hosts")).toExist(),
			expectView(role("link", { name: /busy/ })).toHaveAttr("href", "/infra/hosts/busy"),
			click(role("button", { name: /Elevated/ })),
		)
		const scoped = pageUpdate(loaded([host("busy", 0.7)]), Message.ChangedScope({ scope: "elevated" }))
		expect(scoped.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/hosts?scope=elevated", isReplace: false }),
		)
	})

	test("an empty org shows the setup state; a search with no match shows the filtered state", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([])),
			expectView(text("No hosts reporting yet")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded([host("busy", 0.7)], { q: "nope" })),
			expectView(text("No hosts match")).toExist(),
		)
	})

	test("a column head sorts by name ascending, then flips", () => {
		const sorted = pageUpdate(loaded([host("b", 0.1)]), Message.ClickedSort({ key: "hostName" })).model
		expect(sorted.sort).toEqual({ key: "hostName", dir: "asc" })
		expect(pageUpdate(sorted, Message.ClickedSort({ key: "hostName" })).model.sort.dir).toBe("desc")
	})
})
