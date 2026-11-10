import { OrgId } from "@maple/domain"
import { VercelIntegrationStatus, VercelProjectStatus } from "@maple/domain/http"
import { Array as Arr, Result, Schema, String as Str } from "effect"
import {
	all,
	expect as expectView,
	given,
	inside,
	Mount,
	nth,
	role,
	scene,
	selector,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Chart from "@maple/views/charts/chart"
import { MountChart } from "@maple/views/charts/chart-mounts"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import {
	VERCEL_AI_GATEWAY,
	VERCEL_ALL_DRAINS_STATUS,
	VERCEL_AUDIT_LOG,
	VERCEL_BUCKETS,
	VERCEL_LATENCY_BUCKETS,
	VERCEL_PROJECTS,
	VERCEL_SPEED_INSIGHTS,
	VERCEL_STATUS,
	VERCEL_TEAM_DEPLOYMENTS,
	VERCEL_TRACES_ONLY_PROJECTS,
	VERCEL_TRACES_ONLY_STATUS,
	VERCEL_WEB_ANALYTICS,
} from "../../../../lab/vercel-infra-fixtures"
import { PageOutMessage, type PageContext } from "../../../contract"
import { MountLinkedCursor } from "./command"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

// The fixtures are relative to the clock: the window covers their 24 hours of buckets.
const BUCKET_MS = 15 * 60_000
const warehouseTime = (ms: number) => Str.replace("T", " ")(Str.slice(0, 19)(new Date(ms).toISOString()))
const firstBucketMs = Date.parse(VERCEL_BUCKETS[0]?.bucket ?? "")
const NOW = Date.parse(VERCEL_BUCKETS[VERCEL_BUCKETS.length - 1]?.bucket ?? "") + BUCKET_MS
const window = { startTime: warehouseTime(firstBucketMs), endTime: warehouseTime(NOW) }
const later = {
	startTime: warehouseTime(firstBucketMs + 5 * 60_000),
	endTime: warehouseTime(NOW + 5 * 60_000),
}

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const steps = (model: Model, messages: ReadonlyArray<(current: Model) => Message>) =>
	Arr.reduce(messages, model, (current, message) => pageUpdate(current, message(current)).model)

const withStatus = (status: VercelIntegrationStatus, search: Model["search"] = {}): Model =>
	steps(init({ search }, context).model, [
		() => Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		(model) =>
			Message.CompletedLoadStatus({ key: model.status.key ?? "", result: Result.succeed(status) }),
	])

const loaded = (
	status: VercelIntegrationStatus,
	projects: typeof VERCEL_PROJECTS,
	search: Model["search"] = {},
): Model =>
	steps(withStatus(status, search), [
		(model) =>
			Message.CompletedFetchProjects({
				key: model.projects.key ?? "",
				result: Result.succeed(projects),
			}),
		(model) =>
			Message.CompletedFetchBuckets({
				key: model.buckets.key ?? "",
				result: Result.succeed(VERCEL_BUCKETS),
			}),
		(model) =>
			Message.CompletedFetchLatency({
				key: model.latency.key ?? "",
				result: Result.succeed(VERCEL_LATENCY_BUCKETS),
			}),
		(model) =>
			Message.CompletedFetchAiGateway({
				key: model.aiGateway.key ?? "",
				result: Result.succeed(VERCEL_AI_GATEWAY),
			}),
		(model) =>
			Message.CompletedFetchDeployments({
				key: model.deployments.key ?? "",
				result: Result.succeed(VERCEL_TEAM_DEPLOYMENTS),
			}),
		(model) =>
			Message.CompletedFetchSpeedInsights({
				key: model.speedInsights.key ?? "",
				result: Result.succeed(VERCEL_SPEED_INSIGHTS),
			}),
		(model) =>
			Message.CompletedFetchWebAnalytics({
				key: model.webAnalytics.key ?? "",
				result: Result.succeed(VERCEL_WEB_ANALYTICS),
			}),
		(model) =>
			Message.CompletedFetchAuditLog({
				key: model.auditLog.key ?? "",
				result: Result.succeed(VERCEL_AUDIT_LOG),
			}),
	])

/** The commands the status answer starts, the window already resolved. */
const readsFor = (status: VercelIntegrationStatus) => {
	const model = steps(init({ search: {} }, context).model, [
		() => Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	])
	return names(
		pageUpdate(
			model,
			Message.CompletedLoadStatus({ key: model.status.key ?? "", result: Result.succeed(status) }),
		).commands,
	)
}

const notConnected = new VercelIntegrationStatus({
	...VERCEL_STATUS,
	connected: false,
	team: null,
	projects: [],
})

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

/** The chart runtime loaded and every strip's chart mounted. */
const withCharts = (model: Model): Model => ({ ...model, chartRuntime: { _tag: "Ready" } })
const chartsMounted = (strips: number) => [
	Mount.resolve(MountLinkedCursor, Message.AttachedLinkedCursor()),
	...Arr.makeBy(strips, () => Mount.resolve(MountChart, Chart.Message.CompletedMountChart())),
]

const projectsTable = selector('[aria-label="Vercel projects"]')

describe("vercel overview", () => {
	test("entry asks for the status and the window; the warehouse reads wait for a connected status", () => {
		const entered = init({ search: {} }, context)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining(["ResolveVercelWindow", "LoadVercelStatus"]),
		)
		expect(names(entered.commands)).not.toContain("FetchVercelProjects")
		expect(readsFor(VERCEL_STATUS)).toEqual(
			expect.arrayContaining([
				"FetchVercelProjects",
				"FetchVercelRequestSeries",
				"FetchVercelLatencySeries",
				"FetchVercelAiGateway",
				"FetchVercelTeamDeployments",
			]),
		)
	})

	test("a drain that is off is never read", () => {
		const defaults = readsFor(VERCEL_STATUS)
		expect(defaults).not.toContain("FetchVercelSpeedInsights")
		expect(defaults).not.toContain("FetchVercelWebAnalytics")
		expect(defaults).not.toContain("FetchVercelAuditLog")
		expect(readsFor(VERCEL_TRACES_ONLY_STATUS)).not.toContain("FetchVercelRequestSeries")
		expect(
			readsFor(new VercelIntegrationStatus({ ...VERCEL_STATUS, tracesEnabled: false })),
		).not.toContain("FetchVercelLatencySeries")
		expect(readsFor(VERCEL_ALL_DRAINS_STATUS)).toEqual(
			expect.arrayContaining([
				"FetchVercelSpeedInsights",
				"FetchVercelWebAnalytics",
				"FetchVercelAuditLog",
			]),
		)
	})

	test("the projects table lists problems first: erroring, then a failed deploy, then the busiest", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS)),
			themeResolved(),
			expectView(role("heading", { name: "Vercel" })).toExist(),
			inside(
				projectsTable,
				expectView(nth(all.role("link"), 0)).toHaveAttr("href", "/infra/vercel/prj_api"),
				expectView(nth(all.role("link"), 1)).toHaveAttr("href", "/infra/vercel/prj_admin"),
				expectView(nth(all.role("link"), 2)).toHaveAttr("href", "/infra/vercel/prj_storefront"),
				expectView(nth(all.role("link"), 3)).toHaveAttr("href", "/infra/vercel/prj_docs"),
			),
			expectView(text(/1 project not forwarded · marketing-legacy/)).toExist(),
		)
	})

	test("a slow project counts as slow in the band, not as healthy", () => {
		const slowDocs = Arr.map(VERCEL_PROJECTS, (project) =>
			project.projectId === "prj_docs" ? { ...project, p95DurationMs: 1_500 } : project,
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, slowDocs)),
			themeResolved(),
			expectView(text(/1 healthy · 1 slow · 1 build failing · 1 erroring/)).toExist(),
		)
	})

	test("a fleet band cell filters the table to its projects, and pressing it again leaves the filter", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS, { scope: "erroring" })),
			themeResolved(),
			inside(
				projectsTable,
				expectView(role("link", { name: /api/ })).toExist(),
				expectView(role("link", { name: /storefront/ })).toBeAbsent(),
			),
			expectView(text("1 of 4 projects")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS, { scope: "failedDeploys" })),
			themeResolved(),
			inside(
				projectsTable,
				expectView(role("link", { name: /admin/ })).toExist(),
				expectView(role("link", { name: /api/ })).toBeAbsent(),
			),
		)
		const model = loaded(VERCEL_STATUS, VERCEL_PROJECTS)
		expect(pageUpdate(model, Message.ClickedScope({ scope: "erroring" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/vercel?scope=erroring", isReplace: false }),
		)
		const scoped = loaded(VERCEL_STATUS, VERCEL_PROJECTS, { scope: "erroring", q: "api" })
		expect(pageUpdate(scoped, Message.ClickedClearFilters()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/vercel", isReplace: false }),
		)
	})

	test("the strips follow the drains: request strips with logs, function p95 with traces", () => {
		scene(
			{ update: pageUpdate, view },
			given(withCharts(loaded(VERCEL_STATUS, VERCEL_PROJECTS))),
			themeResolved(),
			...chartsMounted(4),
			expectView(text("5xx rate")).toExist(),
			expectView(text("Cache hit")).toExist(),
			expectView(text("Function p95")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				withCharts(
					loaded(
						new VercelIntegrationStatus({ ...VERCEL_STATUS, tracesEnabled: false }),
						VERCEL_PROJECTS,
					),
				),
			),
			themeResolved(),
			...chartsMounted(3),
			expectView(text("5xx rate")).toExist(),
			expectView(text("Function p95")).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(withCharts(loaded(VERCEL_TRACES_ONLY_STATUS, VERCEL_TRACES_ONLY_PROJECTS))),
			themeResolved(),
			...chartsMounted(1),
			expectView(text("Function p95")).toExist(),
			expectView(text("5xx rate")).toBeAbsent(),
		)
	})

	test("the deploy before the 5xx spike is flagged in the rail; a failed build says why", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS)),
			themeResolved(),
			expectView(text("Deploys in this window")).toExist(),
			expectView(text(/5xx after deploy/)).toExist(),
			expectView(text(/build error · Command "vite build" exited with 1/)).toExist(),
		)
	})

	test("the panels show AI Gateway spend by model, and say which real-user drains are off", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS)),
			themeResolved(),
			expectView(text(VERCEL_AI_GATEWAY.models[0]?.model ?? "")).toExist(),
			expectView(text(/Speed Insights is off/)).toExist(),
			expectView(text(/Web Analytics is off/)).toExist(),
			expectView(text("Team activity")).toBeAbsent(),
		)
	})

	test("with every drain on, the overview shows Web Vitals, page views and team activity", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_ALL_DRAINS_STATUS, VERCEL_PROJECTS)),
			themeResolved(),
			expectView(text("needs work")).toExist(),
			expectView(text("184.2K")).toExist(),
			expectView(text("project.env-variable.updated")).toExist(),
			expectView(text(/Speed Insights is off/)).toBeAbsent(),
		)
	})

	test("a retired projects link lands on the one overview", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS, { view: "projects" })),
			themeResolved(),
			expectView(text("Projects in scope")).toExist(),
			inside(projectsTable, expectView(role("link", { name: /storefront/ })).toExist()),
		)
	})

	test("a team that isn't connected never reads the warehouse and offers to connect", () => {
		const model = withStatus(notConnected)
		expect(model.projects.key).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(role("link", { name: "Connect Vercel" })).toHaveAttr(
				"href",
				"/integrations?integration=vercel",
			),
		)
	})

	test("a traces-only connection says why requests read zero, and what an empty window waits for", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_TRACES_ONLY_STATUS, VERCEL_TRACES_ONLY_PROJECTS)),
			themeResolved(),
			expectView(text(/Only traces are forwarded/)).toExist(),
			expectView(role("link", { name: "Forward logs" })).toExist(),
		)
		const quiet = new VercelIntegrationStatus({
			...VERCEL_TRACES_ONLY_STATUS,
			projects: Arr.map(
				VERCEL_STATUS.projects,
				(project) => new VercelProjectStatus({ ...project, forwarded: false }),
			),
		})
		scene(
			{ update: pageUpdate, view },
			given(loaded(quiet, [])),
			themeResolved(),
			expectView(text("No deployment traces in this window")).toExist(),
		)
	})

	test("a failed projects read says so, and a retry asks again", () => {
		const model = steps(withStatus(VERCEL_STATUS), [
			(current) =>
				Message.CompletedFetchProjects({
					key: current.projects.key ?? "",
					result: Result.fail(toLoadFailure("boom")),
				}),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Couldn't load Vercel projects")).toExist(),
		)
		expect(names(pageUpdate(model, Message.ClickedRetryProjects()).commands)).toEqual([
			"FetchVercelProjects",
		])
	})

	test("a failed AI Gateway read keeps the overview and says so in its panel", () => {
		const model = steps(withStatus(VERCEL_STATUS), [
			(current) =>
				Message.CompletedFetchProjects({
					key: current.projects.key ?? "",
					result: Result.succeed(VERCEL_PROJECTS),
				}),
			(current) =>
				Message.CompletedFetchAiGateway({
					key: current.aiGateway.key ?? "",
					result: Result.fail(toLoadFailure("boom")),
				}),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Couldn't load AI Gateway usage")).toExist(),
			inside(projectsTable, expectView(role("link", { name: /storefront/ })).toExist()),
		)
		expect(names(pageUpdate(model, Message.ClickedRetryAiGateway()).commands)).toEqual([
			"FetchVercelAiGateway",
		])
	})

	test("a projects answer for a superseded window is dropped", () => {
		const first = withStatus(VERCEL_STATUS)
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Load" }),
		).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchProjects({
				key: first.projects.key ?? "",
				result: Result.succeed(VERCEL_PROJECTS),
			}),
		)
		expect(late.model.projects).toEqual(second.projects)
	})
})
