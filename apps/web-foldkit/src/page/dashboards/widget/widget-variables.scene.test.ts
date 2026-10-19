import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { FetchVariableOptions, FetchWidget } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { init } from "./update"

// The editor previews a query that reads `$service` at the variable's default value.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

type Step = Readonly<{ model: Model; commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> }>

const throughput = {
	id: "throughput",
	visualization: "chart",
	dataSource: {
		kind: "query",
		resultShape: "timeseries",
		queries: [
			{
				id: "q",
				name: "Throughput",
				dataSource: "traces",
				aggregation: "count",
				whereClause: 'service.name = "$service"',
				addOns: { groupBy: false, having: false, orderBy: false, limit: false, legend: false },
				groupBy: [],
			},
		],
	},
	display: { title: "Throughput", chartId: "query-builder-area" },
	layout: { x: 0, y: 0, w: 6, h: 6 },
}

const board = (variables: ReadonlyArray<unknown>) =>
	Schema.decodeUnknownSync(DashboardDocument)({
		id: "dash_vars",
		name: "Vars",
		timeRange: { type: "relative", value: "6h" },
		widgets: [throughput],
		variables,
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})

const opened = (variables: ReadonlyArray<unknown>): Step =>
	[
		Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
		Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(board(variables)) }),
	].reduce<Step>(
		(step, message) => {
			const next = update(step.model, message, context)
			return { model: next.model, commands: [...step.commands, ...(next.commands ?? [])] }
		},
		{ model: init({ dashboardId: "dash_vars", widgetId: "throughput", search: {} }, context).model, commands: [] },
	)

const sentParams = (step: Step) =>
	JSON.stringify(step.commands.filter(({ name }) => name === FetchWidget.name).map(({ args }) => args))

describe("widget editor variables", () => {
	test("a query reading a variable previews at the variable's default", () => {
		const step = opened([{ name: "service", type: "custom", options: [{ value: "api" }, { value: "web" }], defaultValue: "web" }])
		expect(sentParams(step)).toContain("web")
		expect(sentParams(step)).not.toContain("$service")
	})

	test("a query variable's options load before the preview runs", () => {
		const step = opened([{ name: "service", type: "query", source: { kind: "facet", facet: "service" } }])
		expect(step.commands.map(({ name }) => name)).toContain(FetchVariableOptions.name)
		expect(sentParams(step)).toBe("[]")
		const request = step.model.variableOptions["service"]
		const answered = update(
			step.model,
			Message.CompletedFetchVariableOptions({ name: "service", key: request?.key ?? "", result: Result.succeed(["checkout"]) }),
			context,
		)
		expect(sentParams({ model: answered.model, commands: answered.commands ?? [] })).toContain("checkout")
	})
})
