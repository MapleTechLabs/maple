import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../../contract"
import * as Frame from "../../kit/frame"
import * as Rail from "../lens/rail"
import { Message } from "./message"
import type { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const resolved = Message.GotFrameMessage({
	message: Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "en-US", mode: "Load" }),
})

const workload = {
	serviceName: "payment-svc",
	workloadKind: "deployment" as const,
	workloadName: "payment-svc",
	namespace: "shop",
	clusterName: "prod",
	podCount: 2,
	avgCpuLimitUtilization: 0.3,
	avgMemoryLimitUtilization: 0.4,
}

describe("service lens", () => {
	test("with nothing picked only the rail loads", () => {
		const entered = pageUpdate(init({ search: {} }, context).model, resolved)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining(["FetchLensServiceNames", "FetchLensServiceWorkloads"]),
		)
		expect(names(entered.commands)).not.toContain("FetchLensPods")
	})

	test("a picked service asks for the unscoped pod page first, then the workload's once it lands", () => {
		const entered = pageUpdate(init({ search: {}, serviceName: "payment-svc" }, context).model, resolved)
		expect(names(entered.commands)).toContain("FetchLensPods")
		const linked = pageUpdate(
			entered.model,
			Message.CompletedFetchLinked({ key: entered.model.linked.key ?? "", result: Result.succeed([workload]) }),
		)
		expect(names(linked.commands)).toEqual(expect.arrayContaining(["FetchLensPods", "FetchLensCpu"]))
	})

	test("picking a service keeps the rail and starts the lens body afresh", () => {
		const index = pageUpdate(init({ search: {} }, context).model, resolved).model
		const withNames = pageUpdate(
			index,
			Message.GotRailMessage({
				message: Rail.Message.CompletedFetchNames({ key: index.rail.names.key ?? "", result: Result.succeed(["payment-svc"]) }),
			}),
		).model
		const picked = routeChanged(withNames, { search: {}, serviceName: "payment-svc" }, context)
		expect(picked.model.rail.names).toEqual(withNames.rail.names)
		expect(names(picked.commands)).not.toContain("FetchLensServiceNames")
	})

	test("the rail's service names follow the namespace pin, in the payload and the key", () => {
		const pinned: PageContext = { ...context, pinnedNamespace: "payments" }
		const enter = (ctx: PageContext) => update(init({ search: {} }, ctx).model, resolved, ctx)
		const unpinned = enter(context)
		const entered = enter(pinned)
		const fetch = entered.commands?.find(({ name }) => name === "FetchLensServiceNames")
		const args = fetch?.args !== undefined && "input" in fetch.args ? fetch.args.input : null
		expect(args).toEqual({ ...window, namespaces: ["payments"] })
		expect(entered.model.rail.names.key).not.toEqual(unpinned.model.rail.names.key)
		expect(names(contextChanged(unpinned.model, pinned).commands)).toContain("FetchLensServiceNames")
	})
})
