import { OrgId } from "@maple/domain"
import { VercelIntegrationStatus, VercelProjectStatus } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import { toLoadFailure } from "../../../../data/load-failure"
import {
	VERCEL_AI_GATEWAY,
	VERCEL_BUCKETS,
	VERCEL_PROJECTS,
	VERCEL_STATUS,
	VERCEL_TRACES_ONLY_PROJECTS,
	VERCEL_TRACES_ONLY_STATUS,
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
	(commands ?? []).map(({ name }) => name)
const steps = (model: Model, messages: ReadonlyArray<(current: Model) => Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message(current)).model, model)
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

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
		expect(names(entered.commands)).toEqual([
			"ResolveVercelWindow",
			"LoadVercelStatus",
			"LoadChartRuntime",
		])
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
		expect(names(connected.commands)).toEqual([
			"FetchVercelProjects",
			"FetchVercelRequestSeries",
			"FetchVercelAiGateway",
		])
	})

	test("forwarded projects list with their numbers, a silent one included, and open their page", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS)),
			themeResolved(),
			expectView(text("4 projects")).toExist(),
			expectView(role("heading", { name: "Vercel" })).toExist(),
			expectView(role("link", { name: /storefront/ })).toHaveAttr(
				"href",
				"/infra/vercel/prj_storefront",
			),
			expectView(role("link", { name: /admin/ })).toContainText("feat/audit-log"),
			expectView(role("button", { name: "Open AI Gateway usage" })).toContainText(
				"requests · by model",
			),
		)
	})

	test("the spend cell and the pivot open the AI Gateway view in the URL", () => {
		const model = loaded(VERCEL_STATUS, VERCEL_PROJECTS)
		expect(pageUpdate(model, Message.ClickedView({ view: "aiGateway" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/vercel?view=aiGateway", isReplace: false }),
		)
		expect(pageUpdate(model, Message.ChangedSearch({ value: "api" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/infra/vercel?q=api", isReplace: false }),
		)
	})

	test("the AI Gateway view breaks spend down by model and by project", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(VERCEL_STATUS, VERCEL_PROJECTS, { view: "aiGateway" })),
			themeResolved(),
			expectView(text("By model")).toExist(),
			expectView(text("anthropic/claude-sonnet-4.5")).toExist(),
			expectView(role("link", { name: /storefront/ })).toHaveAttr(
				"href",
				"/infra/vercel/prj_storefront",
			),
			expectView(text("Outside a project")).toExist(),
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
			projects: VERCEL_STATUS.projects.map(
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
			expectView(text("Failed to load Vercel projects")).toExist(),
		)
		expect(names(pageUpdate(model, Message.ClickedRetryProjects()).commands)).toEqual([
			"FetchVercelProjects",
		])
	})

	test("a failed AI Gateway read keeps the projects and marks the spend cell", () => {
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
			expectView(role("button", { name: "Open AI Gateway usage" })).toContainText("couldn't load"),
		)
		scene(
			{ update: pageUpdate, view },
			given({ ...model, search: { view: "aiGateway" } }),
			themeResolved(),
			expectView(text("Failed to load AI Gateway usage")).toExist(),
		)
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
