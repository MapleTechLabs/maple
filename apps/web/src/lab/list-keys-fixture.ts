import * as Policy from "@maple/domain/policy"
import { V2Investigation } from "@maple/domain/http/v2"
import { Array as Arr, Result, Schema } from "effect"
import type { PageContext } from "../page/contract"
import * as Hub from "../page/alerts/hub/update"
import { Message as HubMessage } from "../page/alerts/hub/message"
import * as Dashboards from "../page/dashboards/list/update"
import { Message as DashboardsMessage } from "../page/dashboards/list/message"
import type { ListDashboard } from "../page/dashboards/list/model"
import * as Investigations from "../page/investigations/list/update"
import { Message as InvestigationsMessage } from "../page/investigations/list/message"
import { hubAt, incidentRow, NOW, ORG, ruleId, ruleRow, stateRow } from "../page/kit/alert-test-rows"
import * as Metrics from "../page/metrics/browse/update"
import { Message as MetricsMessage } from "../page/metrics/browse/message"
import type { MetricRow } from "../page/metrics/shared"
import * as Services from "../page/services/list/update"
import { Message as ServicesMessage } from "../page/services/list/message"
import type { ServiceRow } from "../page/services/list/model"
import { VERDICT_LAB_CASES } from "./verdict-fixture"

// `/lab/list-keys`: each list page's Model as its reads would leave it, over a handful of fixture rows.

const WINDOW = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }

const service = (
	serviceName: string,
	environment: string,
	p95LatencyMs: number,
	errorRate: number,
): ServiceRow => ({
	serviceName,
	serviceNamespace: "",
	environment,
	commits: [],
	p50LatencyMs: p95LatencyMs / 3,
	p95LatencyMs,
	p99LatencyMs: p95LatencyMs * 1.8,
	errorRate,
	throughput: 1200 / p95LatencyMs,
	tracedThroughput: 1200 / p95LatencyMs,
	hasSampling: false,
	samplingWeight: 1,
	spanCount: 4200,
})

const SERVICES = [
	service("checkout", "production", 182, 0.012),
	service("payments", "production", 240, 0),
	service("search", "production", 96, 0.002),
	service("orders", "production", 310, 0),
	service("checkout", "staging", 205, 0),
	service("payments", "staging", 260, 0.03),
]

/** Feeds `messages` through a page's update, keeping only the Model. */
const fold = <Model, Message>(
	entered: Model,
	update: (model: Model, message: Message) => { readonly model: Model },
	messages: (model: Model) => ReadonlyArray<Message>,
): Model => Arr.reduce(messages(entered), entered, (model, message) => update(model, message).model)

export const servicesFixture = (context: PageContext) => {
	const step = (model: Parameters<typeof Services.update>[0], message: ServicesMessage) =>
		Services.update(model, message, context)
	const windowed = step(
		Services.init({ search: {} }, context).model,
		ServicesMessage.CompletedResolveWindow({ window: WINDOW, nowMs: NOW, mode: "Load" }),
	).model
	return fold(windowed, step, (model) => [
		ServicesMessage.CompletedFetchOverview({
			key: model.overview.key ?? "",
			result: Result.succeed(SERVICES),
		}),
		ServicesMessage.CompletedFetchSparklines({
			key: model.sparklines.key ?? "",
			result: Result.succeed({}),
		}),
		ServicesMessage.CompletedFetchAnomalies({
			key: model.anomalies.key ?? "",
			result: Result.succeed([]),
		}),
		ServicesMessage.CompletedFetchFacets({
			key: model.facets.key ?? "",
			result: Result.succeed({
				environments: [
					{ name: "production", count: 4 },
					{ name: "staging", count: 2 },
				],
				namespaces: [],
				commitShas: [],
			}),
		}),
		ServicesMessage.UpdatedIncidents({ orgId: context.orgId, incidents: [] }),
		ServicesMessage.CompletedLoadSignalPresence({
			result: Result.succeed({ traces: { status: "present", lastSeenMs: null } }),
		}),
	])
}

const metric = (metricName: string, metricType: string, serviceName: string): MetricRow => ({
	metricName,
	metricType,
	serviceName,
	metricDescription: "",
	metricUnit: "",
	dataPointCount: 18_400,
	firstSeen: "2026-09-30 12:05:00",
	lastSeen: "2026-10-01 11:58:00",
	isMonotonic: false,
})

const METRICS = [
	metric("http.server.request.duration", "histogram", "checkout"),
	metric("http.client.request.duration", "histogram", "payments"),
	metric("process.cpu.time", "sum", "search"),
	metric("process.memory.usage", "gauge", "orders"),
	metric("db.client.connection.count", "gauge", "checkout"),
	metric("queue.messages.published", "sum", "orders"),
]

export const metricsFixture = (context: PageContext) => {
	const step = (model: Parameters<typeof Metrics.update>[0], message: MetricsMessage) =>
		Metrics.update(model, message, context)
	const windowed = step(
		Metrics.init({ search: { view: "table" } }, context).model,
		MetricsMessage.CompletedResolveWindow({ window: WINDOW, nowMs: NOW, mode: "Load" }),
	).model
	return fold(windowed, step, (model) => [
		MetricsMessage.CompletedFetchTable({ key: model.table.key ?? "", result: Result.succeed(METRICS) }),
		MetricsMessage.CompletedFetchSummary({ key: model.summary.key ?? "", result: Result.succeed([]) }),
		MetricsMessage.CompletedLoadSignalPresence({
			result: Result.succeed({ metrics: { status: "present", lastSeenMs: null } }),
		}),
	])
}

const BASE_INVESTIGATION = Arr.getUnsafe(VERDICT_LAB_CASES, 0).investigation
const decodeInvestigationId = Schema.decodeSync(V2Investigation.fields.id)

/** A diagnosed investigation; a later `minute` lists it higher. */
const investigation = (n: number, title: string, minute: number): V2Investigation => ({
	...BASE_INVESTIGATION,
	id: decodeInvestigationId(`${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`),
	snapshot: { ...BASE_INVESTIGATION.snapshot, title },
	updated_at: `2026-10-01T11:${minute}:00.000Z`,
})

const INVESTIGATIONS = [
	investigation(4, "TimeoutError: payment capture exceeded 30s", 52),
	investigation(5, "Checkout p95 latency doubled after deploy 4f2c1a", 41),
	investigation(6, "Search index lag over 5 minutes", 30),
	investigation(7, "Export job retries exhausted", 18),
]

export const investigationsFixture = (context: PageContext) => {
	const step = (model: Parameters<typeof Investigations.update>[0], message: InvestigationsMessage) =>
		Investigations.update(model, message, context)
	return fold(Investigations.init({ search: {} }, context).model, step, (model) => [
		InvestigationsMessage.ReadClock({ nowMs: NOW }),
		InvestigationsMessage.CompletedReadGrants({
			orgId: context.orgId,
			grants: Policy.grantsOf(["org:engineer"]),
		}),
		InvestigationsMessage.CompletedFetchFirstPage({
			key: model.firstPage.key ?? "",
			result: Result.succeed({ data: INVESTIGATIONS, hasMore: false, nextCursor: null }),
		}),
		InvestigationsMessage.CompletedLoadSignalPresence({
			result: Result.succeed({ traces: { status: "present", lastSeenMs: null } }),
		}),
	])
}

const dashboard = (id: string, name: string, description: string, day: number): ListDashboard => ({
	id,
	name,
	description,
	tags: [],
	widgetCount: 8,
	readsShort: "Traces · Errors",
	readsFull: "Traces · Errors",
	glyph: "PulseIcon",
	createdAt: "2026-09-01T12:00:00.000Z",
	updatedAt: `2026-09-${day}T12:00:00.000Z`,
})

const DASHBOARDS = [
	dashboard("dash_platform", "Platform overview", "Cross-service health.", 30),
	dashboard("dash_payment", "Payment service health", "Capture latency and declines.", 28),
	dashboard("dash_checkout", "Checkout funnel", "Cart to order, step by step.", 25),
	dashboard("dash_search", "Search quality", "Latency, zero results and index lag.", 21),
	dashboard("dash_queues", "Queues and workers", "Depth, age and retries.", 14),
]

export const dashboardsFixture = (context: PageContext) => {
	const step = (model: Parameters<typeof Dashboards.update>[0], message: DashboardsMessage) =>
		Dashboards.update(model, message, context)
	return fold(Dashboards.init({ search: {} }, context).model, step, () => [
		DashboardsMessage.CompletedReadClock({ nowMs: NOW, locale: "en-US" }),
		DashboardsMessage.CompletedLoadPreferences({ favorites: ["dash_payment"], sort: "updated" }),
		DashboardsMessage.UpdatedDashboards({ orgId: context.orgId, dashboards: DASHBOARDS }),
	])
}

const incident = (n: number, rule_name: string, fields: Parameters<typeof incidentRow>[0] = {}) =>
	incidentRow({
		id: `0199a003-0000-7000-8000-00000000000${n}`,
		rule_id: ruleId(n),
		incident_key: `rule-${n}:all`,
		dedupe_key: `rule-${n}:all`,
		rule_name,
		...fields,
	})

export const alertsFixture = (context: PageContext) => {
	const step = (model: Parameters<typeof Hub.update>[0], message: HubMessage) =>
		Hub.update(model, message, context)
	return fold(Hub.init(hubAt({}), context).model, step, () => [
		HubMessage.ReadClock({ nowMs: NOW }),
		HubMessage.UpdatedRules({ orgId: ORG, rows: Arr.map([1, 2, 3, 4], (n) => ruleRow(n)) }),
		HubMessage.UpdatedRuleStates({ orgId: ORG, rows: Arr.map([1, 2, 3, 4], (n) => stateRow(n)) }),
		HubMessage.UpdatedIncidents({
			orgId: ORG,
			rows: [
				incident(1, "Payment p95 latency"),
				incident(2, "Checkout p95 latency", { severity: "warning", last_observed_value: 912 }),
				incident(3, "Search p95 latency", { severity: "warning", last_observed_value: 860 }),
				incident(4, "Orders p95 latency", { hold_reason: "no_data" }),
			],
		}),
		HubMessage.UpdatedDestinations({ orgId: ORG, rows: [] }),
		HubMessage.CompletedFetchSession({ orgId: ORG, grants: Policy.grantsOf(["org:engineer"]) }),
	])
}
