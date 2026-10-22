import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import type { PageContext } from "../../contract"
import { FetchMetricKeys, FetchMetricOptions } from "./metric-options"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { init } from "./update"

// One failed metric read must not leave the picker or its "by" choices empty for good.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_metrics",
	name: "Metrics",
	timeRange: { type: "relative", value: "1h" },
	widgets: [
		{
			id: "cpu",
			visualization: "chart",
			dataSource: {
				kind: "query",
				resultShape: "timeseries",
				queries: [
					{
						id: "q",
						name: "CPU",
						dataSource: "metrics",
						metricName: "process.cpu.utilization",
						metricType: "gauge",
						aggregation: "avg",
						whereClause: "",
						addOns: {
							groupBy: false,
							having: false,
							orderBy: false,
							limit: false,
							legend: false,
						},
						groupBy: [],
					},
				],
			},
			display: { title: "CPU", chartId: "query-builder-line" },
			layout: { x: 0, y: 0, w: 6, h: 6 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

type Step = Readonly<{ model: Model; names: ReadonlyArray<string> }>
const step = (model: Model, message: Message): Step => {
	const next = update(model, message, context)
	return { model: next.model, names: (next.commands ?? []).map(({ name }) => name) }
}

const opened = () =>
	[
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
	].reduce<Step>((current, message) => step(current.model, message), {
		model: init({ dashboardId: "dash_metrics", widgetId: "cpu", search: {} }, context).model,
		names: [],
	})

describe("widget editor metric reads", () => {
	test("a failed metric list or key lookup is asked again on the next edit", () => {
		const failedList = step(
			opened().model,
			Message.CompletedFetchMetricOptions({ search: "", result: Result.fail(toLoadFailure("down")) }),
		)
		const failed = step(
			failedList.model,
			Message.CompletedFetchMetricKeys({
				metric: "process.cpu.utilization::gauge",
				result: Result.fail(toLoadFailure("down")),
			}),
		)
		const edited = step(failed.model, Message.ChangedTitle({ value: "CPU busy" }))
		expect(edited.names).toEqual(expect.arrayContaining([FetchMetricOptions.name, FetchMetricKeys.name]))
	})
})
