import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import { toLoadFailure } from "../../../../data/load-failure"
import {
	VERCEL_API_AI_GATEWAY,
	VERCEL_API_DEPLOYMENTS,
	VERCEL_API_DETAIL,
	VERCEL_BUCKETS,
	VERCEL_EMPTY_AI_GATEWAY,
	VERCEL_PROJECTS,
	VERCEL_STATUS,
} from "../../../../lab/vercel-infra-fixtures"
import type { PageContext } from "../../../contract"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { titleOf, view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-02 00:00:00" }
const route = { projectId: "prj_api", search: {} }

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const steps = (model: Model, messages: ReadonlyArray<(current: Model) => Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message(current)).model, model)
const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const failed = Result.fail(toLoadFailure("boom"))

const windowed = (): Model =>
	steps(init(route, context).model, [
		() => Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
	])

const populated = (): Model =>
	steps(windowed(), [
		(model) =>
			Message.CompletedLoadStatus({
				key: model.status.key ?? "",
				result: Result.succeed(VERCEL_STATUS),
			}),
		(model) =>
			Message.CompletedFetchProjects({
				key: model.projects.key ?? "",
				result: Result.succeed(VERCEL_PROJECTS),
			}),
		(model) =>
			Message.CompletedFetchBuckets({
				key: model.buckets.key ?? "",
				result: Result.succeed(VERCEL_BUCKETS),
			}),
		(model) =>
			Message.CompletedFetchDetail({
				key: model.detail.key ?? "",
				result: Result.succeed(VERCEL_API_DETAIL),
			}),
		(model) =>
			Message.CompletedFetchDeployments({
				key: model.deployments.key ?? "",
				result: Result.succeed(VERCEL_API_DEPLOYMENTS),
			}),
		(model) =>
			Message.CompletedFetchAiGateway({
				key: model.aiGateway.key ?? "",
				result: Result.succeed(VERCEL_API_AI_GATEWAY),
			}),
	])

describe("vercel project", () => {
	test("entry reads the status and deployments; the window brings the project's warehouse reads", () => {
		const entered = init(route, context)
		expect(names(entered.commands)).toEqual([
			"ResolveVercelProjectWindow",
			"LoadVercelProjectStatus",
			"FetchVercelDeployments",
			"LoadChartRuntime",
		])
		const resolved = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual([
			"FetchVercelProjectRows",
			"FetchVercelProjectRequestSeries",
			"FetchVercelProjectDetail",
			"FetchVercelProjectAiGateway",
		])
	})

	test("the inventory names the project; its id stands in until then", () => {
		expect(titleOf(windowed())).toBe("prj_api")
		expect(titleOf(populated())).toBe("api")
	})

	test("a loaded project shows its paths, errors, deployments, AI Gateway use and its logs and traces", () => {
		scene(
			{ update: pageUpdate, view },
			given(populated()),
			themeResolved(),
			expectView(role("heading", { name: "api" })).toExist(),
			expectView(text("/api/checkout")).toExist(),
			expectView(text("Task timed out after 10.02 seconds")).toExist(),
			expectView(text("Batch the order writes")).toExist(),
			expectView(role("heading", { name: "AI Gateway" })).toExist(),
			expectView(role("link", { name: "Traces" })).toHaveAttr(
				"href",
				"/traces?whereClause=resource.vercel.projectId+%3D+%22prj_api%22",
			),
			expectView(role("link", { name: "Logs" })).toExist(),
		)
	})

	test("each failed read says so in its own section, and its retry asks only it again", () => {
		const model = steps(windowed(), [
			(current) => Message.CompletedFetchProjects({ key: current.projects.key ?? "", result: failed }),
			(current) => Message.CompletedFetchBuckets({ key: current.buckets.key ?? "", result: failed }),
			(current) => Message.CompletedFetchDetail({ key: current.detail.key ?? "", result: failed }),
			(current) =>
				Message.CompletedFetchDeployments({ key: current.deployments.key ?? "", result: failed }),
			(current) =>
				Message.CompletedFetchAiGateway({ key: current.aiGateway.key ?? "", result: failed }),
		])
		scene(
			{ update: pageUpdate, view },
			given(model),
			themeResolved(),
			expectView(text("Failed to load this project's requests")).toExist(),
			expectView(text("Failed to load top paths and errors")).toExist(),
			expectView(text("Failed to load deployments")).toExist(),
			expectView(text("Failed to load AI Gateway usage")).toExist(),
		)
		expect(names(pageUpdate(model, Message.ClickedRetryRequests()).commands)).toEqual([
			"FetchVercelProjectRows",
			"FetchVercelProjectRequestSeries",
		])
		expect(names(pageUpdate(model, Message.ClickedRetryDeployments()).commands)).toEqual([
			"FetchVercelDeployments",
		])
	})

	test("a project with no AI Gateway requests shows no AI Gateway section", () => {
		const quiet = steps(populated(), [
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
			expectView(role("heading", { name: "AI Gateway" })).toBeAbsent(),
		)
	})
})
