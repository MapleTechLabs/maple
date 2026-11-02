import { OrgId } from "@maple/domain"
import { ErrorIssueId } from "@maple/domain/http"
import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as Chart from "../../../charts/chart"
import { ChartTooltip } from "../../../charts/chart-spec"
import { toLoadFailure } from "../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../route"
import { PageOutMessage, type PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:00:00" }
const later = { startTime: "2026-10-01 00:00:00", endTime: "2026-10-01 12:05:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const entered = () => init({ issueId, search: {} }, context)
const windowed = (): Model =>
	pageUpdate(entered().model, Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })).model

describe("error issue", () => {
	test("entry resolves the window and asks every page-level read, not the panels' yet", () => {
		const commands = names(entered().commands)
		expect(commands).toContain("ResolveIssueWindow")
		expect(commands).toContain("FetchErrorIssueEvents")
		expect(commands).toContain("FetchErrorIssueEscalations")
		expect(commands).not.toContain("FetchErrorIssueAnomalies")
		expect(commands).not.toContain("FetchGithubStatus")
	})

	test("the resolved window asks the detail with 48 buckets in ISO", () => {
		const resolved = pageUpdate(
			entered().model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		expect(names(resolved.commands)).toEqual(["FetchErrorIssueDetail"])
		expect(resolved.model.detail.key).toContain("2026-10-01T00:00:00")
		expect(resolved.model.detail.key).toContain("900")
	})

	test("a detail answer for a superseded window is dropped", () => {
		const first = windowed()
		const second = pageUpdate(
			first,
			Message.CompletedResolveWindow({ window: later, nowMs: NOW, mode: "Load" }),
		).model
		const late = pageUpdate(
			second,
			Message.CompletedFetchDetail({
				key: first.detail.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		)
		expect(late.model.detail).toEqual(second.detail)
	})

	test("a failed detail fails the page and Retry asks it again", () => {
		const model = windowed()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchDetail({
				key: model.detail.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		).model
		expect(AsyncData.isFailure(failed.detail.data)).toBe(true)
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toEqual(["FetchErrorIssueDetail"])
	})

	test("after a Reload a tab change keeps the window; a new preset re-resolves unsnapped", () => {
		const reloaded = pageUpdate(windowed(), Message.ClickedReload()).model
		expect(routeChanged(reloaded, { search: { tab: "activity" } }, context).commands).toBeUndefined()
		const moved = routeChanged(reloaded, { search: { timePreset: "1d" } }, context)
		expect(moved.commands?.map(({ name, args }) => [name, args?.["mode"]])).toEqual([
			["ResolveIssueWindow", "Refresh"],
		])
	})

	test("a tab change keeps the window; a preset change navigates and re-resolves", () => {
		const model = windowed()
		expect(routeChanged(model, { search: { tab: "activity" } }, context).commands).toBeUndefined()
		expect(names(routeChanged(model, { search: { timePreset: "1d" } }, context).commands)).toEqual([
			"ResolveIssueWindow",
		])
		expect(pageUpdate(model, Message.ClickedResetTimeRange()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.ErrorIssue({ issueId, search: { timePreset: "12h" } })),
				isReplace: false,
			}),
		)
	})

	test("hovering the occurrence chart puts the bucket's tooltip on the page's chart", () => {
		const tooltip = ChartTooltip.Bucket({
			heading: "Nov 1, 11:30 AM",
			rows: [{ label: "Occurrences", color: "#e5484d", dashed: false, value: "162" }],
		})
		const hovered = pageUpdate(
			windowed(),
			Message.GotChartMessage({
				message: Chart.Message.ChangedChartTooltip({ maybeTooltip: Option.some(tooltip) }),
			}),
		).model
		expect(hovered.chart.tooltip).toEqual(Option.some(tooltip))
	})
})
