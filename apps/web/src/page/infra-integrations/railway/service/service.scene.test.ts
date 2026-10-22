import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../../data/load-failure"
import type { PageContext } from "../../../contract"
import type { RailwayServiceRow } from "../model"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, timeseriesInput, update } from "./update"
import { titleOf, view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 06:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 06:05:00", endTime: "2026-10-01 12:05:00" }
const route = { serviceId: "svc_api", search: { environmentId: "env_prod" } }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const service: RailwayServiceRow = {
	environmentId: "env_prod",
	serviceId: "svc_api",
	serviceName: "api",
	projectName: "acme-shop",
	environmentName: "production",
	cpuAvg: 1.5,
	cpuMax: 3,
	cpuLimit: 8,
	memoryAvg: 1e9,
	memoryMax: 2e9,
	memoryLimit: 16e9,
	replicas: 2,
	lastSeen: "2026-10-01 12:00:00",
}

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const windowed = (): Model =>
	pageUpdate(init(route, context).model, Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }))
		.model

describe("railway service", () => {
	test("after a Reload an environment change reads under the kept window; only a new preset re-resolves", () => {
		const reloaded = pageUpdate(windowed(), Message.ClickedReload()).model
		const scoped = routeChanged(reloaded, { ...route, search: { environmentId: "env_staging" } }, context)
		expect(names(scoped.commands)).toContain("FetchRailwayServiceTimeseries")
		expect(names(scoped.commands)).not.toContain("ResolveRailwayServiceWindow")
		const moved = routeChanged(
			scoped.model,
			{ ...route, search: { environmentId: "env_staging", timePreset: "1h" } },
			context,
		)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([
			["ResolveRailwayServiceWindow", "Refresh"],
		])
	})

	test("the window brings the fleet read and the service's series, bucketed for ~100 points", () => {
		const entered = init(route, context)
		expect(names(entered.commands)).toContain("ResolveRailwayServiceWindow")
		const resolved = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual(
			expect.arrayContaining(["FetchRailwayServiceRows", "FetchRailwayServiceTimeseries"]),
		)
		expect(timeseriesInput(resolved.model, window)).toEqual({
			...window,
			bucketSeconds: 300,
			serviceId: "svc_api",
			environmentId: "env_prod",
		})
	})

	test("the title and stats come from the service's own row; the id stands in until then", () => {
		const model = windowed()
		expect(titleOf(model)).toBe("svc_api")
		const loaded = pageUpdate(
			model,
			Message.CompletedFetchServices({
				key: model.services.key ?? "",
				result: Result.succeed([service]),
			}),
		).model
		expect(titleOf(loaded)).toBe("api")
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			themeResolved(),
			expectView(text("1.5 vCPU")).toExist(),
		)
	})

	test("a series answer for a superseded window is dropped", () => {
		const first = windowed()
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: 0, mode: "Load" }),
		).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchTimeseries({ key: first.timeseries.key ?? "", result: Result.succeed([]) }),
		)
		expect(late.model.timeseries).toEqual(second.timeseries)
	})

	test("a failed series read says so, and a retry asks again", () => {
		const model = windowed()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchTimeseries({
				key: model.timeseries.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(text("Failed to load service metrics")).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetryTimeseries()).commands)).toContain(
			"FetchRailwayServiceTimeseries",
		)
	})
})
