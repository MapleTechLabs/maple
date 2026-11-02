import { OrgId } from "@maple/domain"
import {
	SupabaseApiTrafficResponse,
	SupabaseIntegrationStatus,
	SupabaseLogIssuesResponse,
	SupabaseProjectCallersResponse,
	SupabaseProjectInsights,
} from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../../charts/theme-colors"
import { toLoadFailure } from "../../../../data/load-failure"
import type { PageContext } from "../../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const REF = "abcdefghijklmnopqrst"
const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const window = { startTime: "2026-10-01 06:00:00", endTime: "2026-10-01 12:00:00" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const status = (logsEnabled: boolean) =>
	Schema.decodeUnknownSync(SupabaseIntegrationStatus)({
		configured: true,
		connected: true,
		organization: { id: "o1", slug: "acme", name: "Acme" },
		connectedByUserId: null,
		connectedAt: null,
		revoked: false,
		lastDiscoveryAt: 1,
		lastDiscoveryError: null,
		projects: [
			{
				ref: REF,
				name: "acme-production",
				region: "eu-west-1",
				status: "ACTIVE_HEALTHY",
				metricsEnabled: true,
				logDrainEnabled: false,
				logDrainError: null,
				logDrainSourceId: null,
				logDrains: [],
				logDrainsCheckedAt: null,
				logsEnabled,
				logsLastPolledAt: null,
				logsError: null,
				lastSeenAt: 1,
			},
		],
	})

const insights = Schema.decodeUnknownSync(SupabaseProjectInsights)({
	projectRef: REF,
	advisors: { error: [], warn: [], info: [] },
	advisorsCheckedAt: null,
	advisorsError: null,
	topQueries: [],
	queriesCheckedAt: null,
	queriesError: null,
})

const themeResolved = () =>
	Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const windowed = (): Model => {
	const entered = init({ projectRef: REF, search: {} }, context).model
	return pageUpdate(entered, Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" })).model
}

/** Every read answered with an empty project: no traffic, callers, issues or advisors. */
const quiet = (logsEnabled: boolean): Model => {
	const model = windowed()
	const answers: ReadonlyArray<Message> = [
		Message.CompletedLoadStatus({
			key: model.status.key ?? "",
			result: Result.succeed(status(logsEnabled)),
		}),
		Message.CompletedFetchTraffic({
			key: model.traffic.key ?? "",
			result: Result.succeed(
				new SupabaseApiTrafficResponse({
					buckets: [],
					requests: 0,
					errors5xx: 0,
					errorRate5xx: 0,
					p95OriginMs: 0,
				}),
			),
		}),
		Message.CompletedFetchCallers({
			key: model.callers.key ?? "",
			result: Result.succeed(new SupabaseProjectCallersResponse({ callers: [] })),
		}),
		Message.CompletedFetchIssues({
			key: model.issues.key ?? "",
			result: Result.succeed(new SupabaseLogIssuesResponse({ issues: [] })),
		}),
		Message.CompletedFetchInsights({ key: model.insights.key ?? "", result: Result.succeed(insights) }),
	]
	return answers.reduce((current, message) => pageUpdate(current, message).model, model)
}

describe("supabase project", () => {
	test("no read waits for the status: advisors load at entry, the rest once the window resolves", () => {
		const entered = init({ projectRef: REF, search: {} }, context)
		expect(names(entered.commands)).toContain("LoadSupabaseProjectStatus")
		expect(names(entered.commands)).toContain("FetchSupabaseProjectInsights")
		// The status is still loading when the window resolves.
		const resolved = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, nowMs: 0, mode: "Load" }),
		)
		expect(names(resolved.commands).toSorted()).toEqual(
			[
				"FetchSupabaseApiTopPaths",
				"FetchSupabaseApiTraffic",
				"FetchSupabaseProjectCallers",
				"FetchSupabaseProjectLogIssues",
				"FetchSupabaseProjectRows",
				"FetchSupabaseProjectTimeseries",
			].toSorted(),
		)
	})

	test("a quiet project with logs on says nothing needs attention and explains the empty panels", () => {
		scene(
			{ update: pageUpdate, view },
			given(quiet(true)),
			themeResolved(),
			expectView(text("Nothing needs attention")).toExist(),
			expectView(text("No API requests in this window")).toExist(),
			expectView(text("No warnings or errors in this window")).toExist(),
			expectView(role("link", { name: "Instrument a service" })).toExist(),
			expectView(role("link", { name: "View logs" })).toExist(),
		)
	})

	test("with logs off, the log-backed panels point at the switch instead of claiming silence", () => {
		scene(
			{ update: pageUpdate, view },
			given(quiet(false)),
			themeResolved(),
			expectView(text("No API requests in this window")).toBeAbsent(),
			expectView(role("link", { name: "View logs" })).toBeAbsent(),
			expectView(role("link", { name: "Open in Supabase" })).toExist(),
		)
	})

	test("a failed advisors read does not also claim nothing needs attention", () => {
		const settled = quiet(true)
		const retrying = pageUpdate(settled, Message.ClickedRetry({ section: "insights" })).model
		const failed = pageUpdate(
			retrying,
			Message.CompletedFetchInsights({
				key: retrying.insights.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			themeResolved(),
			expectView(text("Nothing needs attention")).toBeAbsent(),
		)
	})

	test("a failed advisors read retries only that read", () => {
		const model = windowed()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchInsights({
				key: model.insights.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		).model
		const retried = pageUpdate(failed, Message.ClickedRetry({ section: "insights" }))
		expect(names(retried.commands)).toEqual(["FetchSupabaseProjectInsights"])
	})
})
