import { OrgId } from "@maple/domain"
import { Array as Arr, Result, Schema, String as Str } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { VercelIntegrationStatus } from "@maple/domain/http"
import {
	VERCEL_ALL_DRAINS_STATUS,
	VERCEL_API_AI_GATEWAY,
	VERCEL_API_DEPLOYMENTS,
	VERCEL_API_DETAIL,
	VERCEL_BUCKETS,
	VERCEL_DEPENDENCIES,
	VERCEL_EMPTY_AI_GATEWAY,
	VERCEL_FUNCTIONS,
	VERCEL_PROJECT_SPEED_INSIGHTS,
	VERCEL_PROJECTS,
	VERCEL_STATUS,
	VERCEL_WEB_ANALYTICS,
} from "../../../../lab/vercel-infra-fixtures"
import type { VercelProjectTab } from "../../../../route/search"
import type { PageContext } from "../../../contract"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { titleOf, view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-02 00:00:00" }
const routeTo = (tab?: VercelProjectTab) => ({
	projectId: "prj_api",
	search: tab === undefined ? {} : { tab },
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
const opened = (tab?: VercelProjectTab, status: VercelIntegrationStatus = VERCEL_ALL_DRAINS_STATUS): Model =>
	steps(init(routeTo(tab), context).model, [
		() => Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
		(model) =>
			Message.CompletedLoadStatus({ key: model.status.key ?? "", result: Result.succeed(status) }),
	])

/** Every read the tab asked for, answered with the fixtures. */
const answered = (model: Model): Model =>
	steps(model, [
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
			Message.CompletedFetchDetail({
				key: m.detail.key ?? "",
				result: Result.succeed(VERCEL_API_DETAIL),
			}),
		(m) =>
			Message.CompletedFetchDeployments({
				key: m.deployments.key ?? "",
				result: Result.succeed(VERCEL_API_DEPLOYMENTS),
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
const readsOf = (tab: VercelProjectTab | undefined, status: VercelIntegrationStatus) => {
	const entered = init(routeTo(tab), context)
	const windowed = pageUpdate(
		entered.model,
		Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	)
	const statused = pageUpdate(
		windowed.model,
		Message.CompletedLoadStatus({ key: windowed.model.status.key ?? "", result: Result.succeed(status) }),
	)
	return Arr.filter(
		[...names(entered.commands), ...names(windowed.commands), ...names(statused.commands)],
		Str.startsWith("Fetch"),
	)
}

describe("vercel project", () => {
	test("each tab reads only what it shows", () => {
		const entered = init(routeTo(), context)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining([
				"ResolveVercelProjectWindow",
				"LoadVercelProjectStatus",
				"LoadChartRuntime",
			]),
		)
		expect(readsOf(undefined, VERCEL_STATUS)).toEqual([
			"FetchVercelProjectRows",
			"FetchVercelProjectRequestSeries",
			"FetchVercelProjectDetail",
		])
		expect(readsOf("functions", VERCEL_STATUS)).toEqual([
			"FetchVercelProjectRows",
			"FetchVercelProjectFunctions",
		])
		expect(readsOf("builds", VERCEL_STATUS)).toEqual(["FetchVercelDeployments"])
		expect(readsOf("speedInsights", VERCEL_ALL_DRAINS_STATUS)).toEqual([
			"FetchVercelProjectSpeedInsights",
		])
	})

	test("a tab whose drain is off reads nothing and says how to turn it on", () => {
		const tracesOff = new VercelIntegrationStatus({ ...VERCEL_STATUS, tracesEnabled: false })
		expect(readsOf("dependencies", tracesOff)).toEqual([])
		expect(readsOf("speedInsights", VERCEL_STATUS)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(opened("speedInsights", VERCEL_STATUS)),
			themeResolved(),
			expectView(text(/Speed Insights is off/)).toExist(),
			expectView(role("link", { name: "Turn on in settings" })).toHaveAttr(
				"href",
				"/integrations?integration=vercel",
			),
		)
	})

	test("the inventory names the project; its id stands in until then", () => {
		expect(titleOf(steps(init(routeTo(), context).model, []))).toBe("prj_api")
		expect(titleOf(opened())).toBe("api")
	})

	test("traffic shows the project's paths with their cache hits, its errors, and its logs and traces", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(opened())),
			themeResolved(),
			expectView(role("heading", { name: "api" })).toExist(),
			expectView(text("/api/checkout")).toExist(),
			expectView(text("Task timed out after 10.02 seconds")).toExist(),
			expectView(role("link", { name: "Traces" })).toHaveAttr(
				"href",
				"/traces?whereClause=resource.vercel.projectId+%3D+%22prj_api%22",
			),
			expectView(role("link", { name: "Functions" })).toHaveAttr(
				"href",
				"/infra/vercel/prj_api?tab=functions",
			),
		)
	})

	test("functions show cold-start rate and init time per route", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(opened("functions"))),
			themeResolved(),
			expectView(text("/api/products/[id]")).toExist(),
			expectView(text("15% · 18.2K")).toExist(),
		)
	})

	test("dependencies list the hosts the functions call and open the project on the service map", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(opened("dependencies"))),
			themeResolved(),
			expectView(text("api.stripe.com")).toExist(),
			expectView(role("link", { name: "Open in the service map" })).toHaveAttr(
				"href",
				"/service-map?focusService=api",
			),
		)
	})

	test("builds show their time, why a failed one stopped, and its build logs", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(opened("builds"))),
			themeResolved(),
			expectView(text("Batch the order writes")).toExist(),
			expectView(text('BUILD_FAILED: Command "vite build" exited with 1')).toExist(),
			expectView(text("newest first, 1 failed")).toExist(),
		)
	})

	test("Speed Insights and Web Analytics break readings down for the project", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(opened("speedInsights"))),
			themeResolved(),
			expectView(text("/products/[slug]")).toExist(),
			expectView(text("mobile")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(answered(opened("webAnalytics"))),
			themeResolved(),
			expectView(text("https://news.ycombinator.com")).toExist(),
			expectView(text("Signup")).toExist(),
		)
	})

	test("a failed read says so in its tab, and its retry asks only it again", () => {
		const failedRequests = steps(opened(), [
			(current) => Message.CompletedFetchProjects({ key: current.projects.key ?? "", result: failed }),
			(current) => Message.CompletedFetchBuckets({ key: current.buckets.key ?? "", result: failed }),
			(current) => Message.CompletedFetchDetail({ key: current.detail.key ?? "", result: failed }),
		])
		scene(
			{ update: pageUpdate, view },
			given(failedRequests),
			themeResolved(),
			expectView(text("Couldn't load this project's requests")).toExist(),
			expectView(text("Couldn't load top paths and errors")).toExist(),
		)
		const retried = names(pageUpdate(failedRequests, Message.ClickedRetryRequests()).commands)
		expect(retried).toEqual(
			expect.arrayContaining(["FetchVercelProjectRows", "FetchVercelProjectRequestSeries"]),
		)
		expect(retried).not.toContain("FetchVercelProjectDetail")
		const failedFunctions = steps(opened("functions"), [
			(current) =>
				Message.CompletedFetchFunctions({ key: current.functions.key ?? "", result: failed }),
		])
		scene(
			{ update: pageUpdate, view },
			given(failedFunctions),
			themeResolved(),
			expectView(text("Couldn't load functions")).toExist(),
		)
		expect(names(pageUpdate(failedFunctions, Message.ClickedRetryFunctions()).commands)).toContain(
			"FetchVercelProjectFunctions",
		)
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
