import { OrgId } from "@maple/domain"
import { VercelIntegrationStatus, VercelProjectStatus } from "@maple/domain/http"
import { Array as Arr, Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import {
	VERCEL_AI_GATEWAY,
	VERCEL_ALL_DRAINS_STATUS,
	VERCEL_AUDIT_LOG,
	VERCEL_BUCKETS,
	VERCEL_PROJECTS,
	VERCEL_SPEED_INSIGHTS,
	VERCEL_STATUS,
	VERCEL_TEAM_DEPLOYMENTS,
	VERCEL_TRACES_ONLY_PROJECTS,
	VERCEL_TRACES_ONLY_STATUS,
	VERCEL_WEB_ANALYTICS,
} from "../../../../lab/vercel-infra-fixtures"
import { PageOutMessage, type PageContext } from "../../../contract"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-02 00:00:00" }
const later = { startTime: "2026-10-01 00:05:00", endTime: "2026-10-02 00:05:00" }
const NOW = Date.UTC(2026, 9, 2)

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

/** The window resolved, the status not yet answered. */
const withStatusOnly = (): Model =>
	steps(init({ search: {} }, context).model, [
		() => Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	])

const notConnected = new VercelIntegrationStatus({
	...VERCEL_STATUS,
	connected: false,
	team: null,
	projects: [],
})

describe("vercel list", () => {
	test("entry asks for the status and the window; the warehouse reads wait for a connected status", () => {
		const entered = init({ search: {} }, context)
		expect(names(entered.commands)).toEqual(
			expect.arrayContaining(["ResolveVercelWindow", "LoadVercelStatus"]),
		)
		expect(names(entered.commands)).not.toContain("FetchVercelProjects")
		const windowed = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(windowed.commands)).toEqual([])
		const connected = pageUpdate(
			windowed.model,
			Message.CompletedLoadStatus({
				key: windowed.model.status.key ?? "",
				result: Result.succeed(VERCEL_STATUS),
			}),
		)
		expect(names(connected.commands)).toEqual(
			expect.arrayContaining([
				"FetchVercelProjects",
				"FetchVercelRequestSeries",
				"FetchVercelAiGateway",
				"FetchVercelTeamDeployments",
			]),
		)
	})

	test("the overview reads only the sections whose drain is on", () => {
		const answered = (status: VercelIntegrationStatus) => {
			const model = withStatusOnly()
			return names(
				pageUpdate(
					model,
					Message.CompletedLoadStatus({
						key: model.status.key ?? "",
						result: Result.succeed(status),
					}),
				).commands,
			)
		}
		const off = answered(VERCEL_STATUS)
		expect(off).not.toContain("FetchVercelSpeedInsights")
		expect(off).not.toContain("FetchVercelWebAnalytics")
		expect(off).not.toContain("FetchVercelAuditLog")
		expect(answered(VERCEL_ALL_DRAINS_STATUS)).toEqual(
			expect.arrayContaining([
				"FetchVercelSpeedInsights",
				"FetchVercelWebAnalytics",
				"FetchVercelAuditLog",
			]),
		)
	})

	test("the overview shows headline traffic, spend by project with a no-project row, and builds", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS)),
			expectView(role("heading", { name: "Vercel" })).toExist(),
			expectView(text("Cold starts")).toExist(),
			expectView(text("3.9%")).toExist(),
			expectView(role("link", { name: /storefront/ })).toHaveAttr(
				"href",
				"/infra/vercel/prj_storefront",
			),
			expectView(text("No project")).toExist(),
			expectView(text('BUILD_FAILED: Command "vite build" exited with 1')).toExist(),
			expectView(text(/Speed Insights is off/)).toExist(),
			expectView(text(/Web Analytics is off/)).toExist(),
			expectView(text(/The audit log is off/)).toExist(),
		)
	})

	test("with every drain on, the overview shows Web Vitals, page views and audit events", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_ALL_DRAINS_STATUS, VERCEL_PROJECTS)),
			expectView(text("needs improvement")).toExist(),
			expectView(text("184.2K")).toExist(),
			expectView(text("project.env-variable.updated")).toExist(),
			expectView(text(/Speed Insights is off/)).toBeAbsent(),
		)
	})

	test("the projects view lists every forwarded project, a silent one included, and opens its page", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS, { view: "projects" })),
			expectView(text("4 projects")).toExist(),
			expectView(role("link", { name: /storefront/ })).toHaveAttr(
				"href",
				"/infra/vercel/prj_storefront",
			),
			expectView(role("link", { name: /admin/ })).toContainText("feat/audit-log"),
			expectView(role("link", { name: "Projects 4" })).toHaveAttr(
				"href",
				"/infra/vercel?view=projects",
			),
		)
		const model = loaded(VERCEL_STATUS, VERCEL_PROJECTS, { view: "projects" })
		expect(pageUpdate(model, Message.ChangedSearch({ value: "api" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/infra/vercel?q=api&view=projects",
				isReplace: false,
			}),
		)
	})

	test("the projects view reads only the projects", () => {
		const model = steps(init({ search: { view: "projects" } }, context).model, [
			() => Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		])
		expect(
			names(
				pageUpdate(
					model,
					Message.CompletedLoadStatus({
						key: model.status.key ?? "",
						result: Result.succeed(VERCEL_ALL_DRAINS_STATUS),
					}),
				).commands,
			),
		).toEqual(["FetchVercelProjects"])
	})

	test("a retired AI Gateway link lands on the overview", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS, { view: "aiGateway" })),
			expectView(text("AI Gateway spend")).toExist(),
			expectView(text("Builds")).toExist(),
		)
	})

	test("a team that isn't connected never reads the warehouse and offers to connect", () => {
		const model = withStatus(notConnected)
		expect(model.projects.key).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(model),
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
			expectView(text("Couldn't load Vercel projects")).toExist(),
		)
		expect(names(pageUpdate(model, Message.ClickedRetryProjects()).commands)).toEqual([
			"FetchVercelProjects",
		])
	})

	test("a failed AI Gateway read keeps the overview and says so in its section", () => {
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
			expectView(text("Couldn't load AI Gateway usage")).toExist(),
			expectView(text("couldn't load")).toExist(),
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
