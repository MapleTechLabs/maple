import { OrgId } from "@maple/domain"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Array as Arr, Result, Schema, String as Str } from "effect"
import {
	expect as expectView,
	given,
	Mount,
	role,
	scene,
	type SceneStep,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Chart from "@maple/views/charts/chart"
import { MountChart } from "@maple/views/charts/chart-mounts"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { type VercelDeploymentSummary, VercelIntegrationStatus } from "@maple/domain/http"
import {
	VERCEL_ALL_DRAINS_STATUS,
	VERCEL_API_AI_GATEWAY,
	VERCEL_API_DEPLOYMENTS,
	VERCEL_API_DETAIL,
	VERCEL_BREAKDOWN,
	VERCEL_BUCKETS,
	VERCEL_DEPENDENCIES,
	VERCEL_EMPTY_AI_GATEWAY,
	VERCEL_FUNCTIONS,
	VERCEL_LATENCY_BUCKETS,
	VERCEL_PROJECT_SPEED_INSIGHTS,
	VERCEL_PROJECTS,
	VERCEL_STATUS,
	VERCEL_WEB_ANALYTICS,
} from "../../../../lab/vercel-infra-fixtures"
import type { InfraVercelProjectSearch } from "../../../../route/search"
import type { PageContext, PageOutMessage } from "../../../contract"
import { MountLinkedCursor } from "./command"
import { Message, type Model } from "./model"
import { init, routeChanged, update } from "./update"
import { titleOf, view as pageView } from "./view"

type Search = typeof InfraVercelProjectSearch.Type
type Tab = Search["tab"]

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
/** The fixtures' own day: their buckets and deploys are relative to when they load. */
const window = {
	startTime: formatWarehouseDateTime(Date.parse(VERCEL_BUCKETS[0]?.bucket ?? "")),
	endTime: formatWarehouseDateTime(
		Date.parse(VERCEL_BUCKETS[VERCEL_BUCKETS.length - 1]?.bucket ?? "") + 15 * 60_000,
	),
}
const routeTo = (tab?: Tab, search: Search = {}) => ({
	projectId: "prj_api",
	search: tab === undefined ? search : { ...search, tab },
})

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const steps = (model: Model, messages: ReadonlyArray<(current: Model) => Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message(current)).model)
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const failed = Result.fail(toLoadFailure("boom"))

/** The page on one tab, its window resolved and the status answered. */
const opened = (
	tab?: Tab,
	status: VercelIntegrationStatus = VERCEL_ALL_DRAINS_STATUS,
	search: Search = {},
): Model =>
	steps(init(routeTo(tab, search), context).model, [
		() => Message.CompletedResolveWindow({ window, nowMs: Date.now(), mode: "Load" }),
		(model) =>
			Message.CompletedLoadStatus({ key: model.status.key ?? "", result: Result.succeed(status) }),
	])

/** Every read the tab asked for, answered with the fixtures, and the chart runtime in. */
const answered = (
	model: Model,
	deployments: ReadonlyArray<VercelDeploymentSummary> = VERCEL_API_DEPLOYMENTS,
): Model =>
	steps(model, [
		() => Message.CompletedLoadChartRuntime(),
		(m) =>
			Message.CompletedFetchProjects({
				key: m.projects.key ?? "",
				result: Result.succeed(VERCEL_PROJECTS),
			}),
		(m) =>
			Message.CompletedFetchBuckets({
				key: m.buckets.key ?? "",
				result: Result.succeed(VERCEL_BUCKETS),
			}),
		(m) =>
			Message.CompletedFetchLatency({
				key: m.latency.key ?? "",
				result: Result.succeed(VERCEL_LATENCY_BUCKETS),
			}),
		(m) =>
			Message.CompletedFetchBreakdown({
				key: m.breakdown.key ?? "",
				result: Result.succeed(VERCEL_BREAKDOWN.rows),
			}),
		(m) =>
			Message.CompletedFetchDetail({
				key: m.detail.key ?? "",
				result: Result.succeed(VERCEL_API_DETAIL),
			}),
		(m) =>
			Message.CompletedFetchDeployments({
				key: m.deployments.key ?? "",
				result: Result.succeed(deployments),
			}),
		(m) =>
			Message.CompletedFetchAiGateway({
				key: m.aiGateway.key ?? "",
				result: Result.succeed(VERCEL_API_AI_GATEWAY),
			}),
		(m) =>
			Message.CompletedFetchFunctions({
				key: m.functions.key ?? "",
				result: Result.succeed(VERCEL_FUNCTIONS),
			}),
		(m) =>
			Message.CompletedFetchDependencies({
				key: m.dependencies.key ?? "",
				result: Result.succeed(VERCEL_DEPENDENCIES),
			}),
		(m) =>
			Message.CompletedFetchSpeedInsights({
				key: m.speedInsights.key ?? "",
				result: Result.succeed(VERCEL_PROJECT_SPEED_INSIGHTS),
			}),
		(m) =>
			Message.CompletedFetchWebAnalytics({
				key: m.webAnalytics.key ?? "",
				result: Result.succeed(VERCEL_WEB_ANALYTICS),
			}),
	])

/** Every warehouse and API read the tab asks for once its window and the status are in. */
const readsOf = (tab: Tab, status: VercelIntegrationStatus) => {
	const entered = init(routeTo(tab), context)
	const windowed = pageUpdate(
		entered.model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	)
	const statused = pageUpdate(
		windowed.model,
		Message.CompletedLoadStatus({ key: windowed.model.status.key ?? "", result: Result.succeed(status) }),
	)
	return Arr.sort(
		Arr.filter(
			[...names(entered.commands), ...names(windowed.commands), ...names(statused.commands)],
			Str.startsWith("Fetch"),
		),
		Str.Order,
	)
}

/** The rail's reads, on every tab. */
const RAIL_READS = [
	"FetchVercelDeployments",
	"FetchVercelProjectDependencies",
	"FetchVercelProjectFunctions",
	"FetchVercelProjectRows",
]
const withRail = (...reads: ReadonlyArray<string>) => Arr.sort([...RAIL_READS, ...reads], Str.Order)

/** The traffic tab with its five strips mounted. */
const trafficScene = (
	model: Model,
	...assertions: ReadonlyArray<SceneStep<Model, Message, PageOutMessage>>
) =>
	scene(
		{ update: pageUpdate, view },
		given(model),
		themeResolved(),
		Mount.resolve(MountLinkedCursor, Message.AttachedLinkedCursor()),
		...Arr.makeBy(5, () => Mount.resolve(MountChart, Chart.Message.CompletedMountChart())),
		...assertions,
	)

describe("vercel project", () => {
	test("each tab reads what it shows, beside the rail's reads", () => {
		expect(names(init(routeTo(), context).commands)).toEqual(
			expect.arrayContaining([
				"ResolveVercelProjectWindow",
				"LoadVercelProjectStatus",
				"LoadChartRuntime",
			]),
		)
		expect(readsOf(undefined, VERCEL_STATUS)).toEqual(
			withRail(
				"FetchVercelProjectBreakdown",
				"FetchVercelProjectDetail",
				"FetchVercelProjectLatencySeries",
				"FetchVercelProjectRequestSeries",
			),
		)
		expect(readsOf("functions", VERCEL_STATUS)).toEqual(withRail())
		expect(readsOf("builds", VERCEL_STATUS)).toEqual(withRail())
		expect(readsOf("users", VERCEL_ALL_DRAINS_STATUS)).toEqual(
			withRail("FetchVercelProjectSpeedInsights", "FetchVercelProjectWebAnalytics"),
		)
		expect(readsOf("aiGateway", VERCEL_STATUS)).toEqual(withRail("FetchVercelProjectAiGateway"))
	})

	test("a retired tab opens the tab that took it in", () => {
		expect(readsOf("dependencies", VERCEL_STATUS)).toEqual(readsOf("functions", VERCEL_STATUS))
		expect(readsOf("speedInsights", VERCEL_ALL_DRAINS_STATUS)).toEqual(
			readsOf("users", VERCEL_ALL_DRAINS_STATUS),
		)
		expect(readsOf("webAnalytics", VERCEL_ALL_DRAINS_STATUS)).toEqual(
			readsOf("users", VERCEL_ALL_DRAINS_STATUS),
		)
		scene(
			{ update: pageUpdate, view },
			given(answered(opened("dependencies"))),
			themeResolved(),
			expectView(role("link", { name: /^Functions/ })).toHaveAttr("aria-current", "page"),
			expectView(role("link", { name: "Open in the service map" })).toHaveAttr(
				"href",
				"/service-map?focusService=api&timePreset=24h",
			),
		)
	})

	test("a drain that is off is not read, and its section says how to turn it on", () => {
		const tracesOff = new VercelIntegrationStatus({ ...VERCEL_STATUS, tracesEnabled: false })
		expect(readsOf(undefined, tracesOff)).toEqual(
			Arr.sort(
				[
					"FetchVercelDeployments",
					"FetchVercelProjectRows",
					"FetchVercelProjectBreakdown",
					"FetchVercelProjectDetail",
					"FetchVercelProjectRequestSeries",
				],
				Str.Order,
			),
		)
		expect(readsOf("users", VERCEL_STATUS)).toEqual(withRail())
		scene(
			{ update: pageUpdate, view },
			given(opened("users", VERCEL_STATUS)),
			themeResolved(),
			expectView(text(/Speed Insights is off/)).toExist(),
			expectView(text(/Web Analytics is off/)).toExist(),
		)
	})

	test("a failed status read says so in the rail instead of loading forever", () => {
		const model = steps(init(routeTo(), context).model, [
			() => Message.CompletedResolveWindow({ window, nowMs: Date.now(), mode: "Load" }),
			(m) => Message.CompletedLoadStatus({ key: m.status.key ?? "", result: failed }),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Couldn't load the Vercel connection")).toExist(),
		)
	})

	test("the inventory names the project; its id stands in until then", () => {
		expect(titleOf(init(routeTo(), context).model)).toBe("prj_api")
		expect(titleOf(opened())).toBe("api")
	})

	test("traffic shows the strips, the breakdown, the error logs, the rail and the project's links", () => {
		trafficScene(
			answered(opened()),
			expectView(role("heading", { name: "api" })).toExist(),
			expectView(role("link", { name: "service api" })).toHaveAttr(
				"href",
				"/services/api?timePreset=24h",
			),
			expectView(text("Cold starts")).toExist(),
			expectView(text("/api/checkout")).toExist(),
			expectView(text("(none)")).toExist(),
			// Errors are grouped by pattern; each keeps its newest line and links to it.
			expectView(text("Error: connect ETIMEDOUT <ip>:5432 at TCPConnectWrap.afterConnect")).toExist(),
			expectView(text(/^Error: connect ETIMEDOUT 10\.0\.4\.12:5432/)).toExist(),
			expectView(role("link", { name: /^Newest trace: Error: connect ETIMEDOUT/ })).toHaveAttr(
				"href",
				"/traces/4bf92f3577b34da6a3ce929d0e0e4736",
			),
			expectView(role("link", { name: /^Logs: START RequestId/ })).toHaveAttr(
				"href",
				"/logs?severities=%5B%22ERROR%22%2C%22FATAL%22%5D&attrs=%5B%22res%3Avercel.project.id%3Dprj_api%22%5D&search=%5BGET%5D+%2Fapi%2Fquote%3Fpage%3D&timePreset=24h",
			),
			// A pattern whose newest line carried no trace has no trace link.
			expectView(role("link", { name: /^Newest trace: START RequestId/ })).not.toExist(),
			expectView(text("Slowest functions")).toExist(),
			expectView(text("/api/products/[id]")).toExist(),
			expectView(text("api.stripe.com")).toExist(),
			expectView(role("link", { name: "Traces" })).toHaveAttr(
				"href",
				"/traces?whereClause=resource.vercel.projectId+%3D+%22prj_api%22&timePreset=24h",
			),
		)
	})

	test("a production deploy the 5xx rate jumped after gets a callout; without it there is none", () => {
		trafficScene(
			answered(opened()),
			expectView(text(/5xx rose to .+ after apiz39f and recovered with apiz49f/)).toExist(),
			expectView(role("link", { name: "Open traces" })).toExist(),
		)
		trafficScene(
			answered(
				opened(),
				Arr.filter(VERCEL_API_DEPLOYMENTS, (d) => d.id !== "api-z3"),
			),
			expectView(text(/5xx rose to/)).toBeAbsent(),
		)
	})

	test("the breakdown's grouping and status narrowing are the URL's, and refetch only the breakdown", () => {
		const model = answered(opened())
		const navigation = pageUpdate(model, Message.ClickedBreakdownBy({ by: "host" })).outMessage
		expect(navigation).toMatchObject({ url: "/infra/vercel/prj_api?by=host" })
		expect(names(routeChanged(model, routeTo(undefined, { by: "host" }), context).commands)).toEqual([
			"FetchVercelProjectBreakdown",
		])
		expect(names(routeChanged(model, routeTo(undefined, { status: "5xx" }), context).commands)).toEqual([
			"FetchVercelProjectBreakdown",
		])
		trafficScene(
			answered(opened(undefined, VERCEL_ALL_DRAINS_STATUS, { status: "5xx" })),
			expectView(role("button", { name: "Remove status = 5xx" })).toExist(),
		)
	})

	test("functions list routes with their cold starts, then the hosts they call", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(opened("functions"))),
			themeResolved(),
			expectView(text("15% · 18.2K")).toExist(),
			expectView(role("heading", { name: "Dependencies" })).toExist(),
		)
	})

	test("builds show their time, why a failed one stopped, and the rail's build history", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(opened("builds"))),
			themeResolved(),
			expectView(text("Batch the order writes")).toExist(),
			expectView(text('BUILD_FAILED: Command "vite build" exited with 1')).toExist(),
			expectView(text(/median .+ · 1 failed/)).toExist(),
		)
	})

	test("real users break Speed Insights and Web Analytics down for the project", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(opened("users"))),
			themeResolved(),
			expectView(text("/products/[slug]")).toExist(),
			expectView(text("https://news.ycombinator.com")).toExist(),
		)
	})

	test("a failed read says so in its tab, and its retry asks only it again", () => {
		const failedRequests = steps(opened(), [
			() => Message.CompletedLoadChartRuntime(),
			(current) => Message.CompletedFetchBuckets({ key: current.buckets.key ?? "", result: failed }),
			(current) => Message.CompletedFetchDetail({ key: current.detail.key ?? "", result: failed }),
			(current) =>
				Message.CompletedFetchBreakdown({ key: current.breakdown.key ?? "", result: failed }),
		])
		scene(
			{ update: pageUpdate, view },
			given(failedRequests),
			themeResolved(),
			expectView(text("Couldn't load this project's requests")).toExist(),
			expectView(text("Couldn't load error logs")).toExist(),
			expectView(text("Couldn't load the Path breakdown")).toExist(),
		)
		const retried = names(pageUpdate(failedRequests, Message.ClickedRetryRequests()).commands)
		expect(retried).toEqual(expect.arrayContaining(["FetchVercelProjectRequestSeries"]))
		expect(retried).not.toContain("FetchVercelProjectDetail")
		expect(names(pageUpdate(failedRequests, Message.ClickedRetryBreakdown()).commands)).toEqual([
			"FetchVercelProjectBreakdown",
		])
	})

	test("a project with no AI Gateway requests says what makes them show up", () => {
		const quiet = steps(answered(opened("aiGateway")), [
			(model) =>
				Message.CompletedFetchAiGateway({
					key: model.aiGateway.key ?? "",
					result: Result.succeed(VERCEL_EMPTY_AI_GATEWAY),
				}),
		])
		scene(
			{ update: pageUpdate, view },
			given(quiet),
			themeResolved(),
			expectView(text("Requests through AI Gateway appear here")).toExist(),
		)
	})
})
