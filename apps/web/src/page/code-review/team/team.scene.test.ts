import { CodeReviewTeam } from "@maple/domain/http"
import { Result, Schema, String as Str } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { FrameMessage } from "../kit/frame"
import { context, names, NOW, window } from "../kit/test-fixtures"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

type Search = Parameters<typeof init>[0]["search"]

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const resolved = Message.GotFrameMessage({
	message: FrameMessage.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
})
const windowed = (search: Search = {}) => pageUpdate(init({ search }, context).model, resolved)

const member = (login: string, pullRequests: number, resolvedFindings: number) => ({
	login,
	pullRequests,
	mergedPullRequests: pullRequests,
	medianMergeSeconds: 3_600,
	findings: resolvedFindings + 1,
	criticalFindings: 0,
	resolvedFindings,
	openAtMergeFindings: 1,
	shippedClean: 1,
	shippedRegressed: 0,
	ciRuns: 20,
	firstTryRuns: 16,
	firstTryGreen: 12,
	reruns: 1,
	cancelledRuns: 3,
	runnerMs: 3_600_000,
})

const teamOf = (
	members: ReadonlyArray<ReturnType<typeof member>>,
	runnerMs = 0,
	activity: ReadonlyArray<Record<string, unknown>> = [],
) =>
	Schema.decodeUnknownSync(CodeReviewTeam)({
		startTime: NOW - 30 * 86_400_000,
		endTime: NOW,
		activityStartTime: NOW - 365 * 86_400_000,
		totals: {
			pullRequests: 12,
			mergedPullRequests: 10,
			medianMergeSeconds: 7_200,
			medianFirstReviewSeconds: 240,
			defaultBranchRuns: 40,
			defaultBranchFailed: 2,
			runnerMs,
			p95QueueMs: 30_000,
		},
		members,
		activity,
	})

const answered = (model: Model, team: CodeReviewTeam) =>
	pageUpdate(model, Message.CompletedFetchTeam({ key: model.team.key ?? "", result: Result.succeed(team) }))
		.model

describe("code review team", () => {
	test("entry reads the team once", () => {
		expect(names(windowed().commands)).toEqual(["FetchCodeReviewTeam"])
	})

	test("sorting by a column puts it in the URL, and a second click goes back to by person", () => {
		const model = windowed().model
		expect(pageUpdate(model, Message.ClickedSort({ sort: "fixRate" })).outMessage).toMatchObject({
			url: "/code-review/team?sort=fixRate",
		})
		const sorted = windowed({ sort: "fixRate" }).model
		expect(pageUpdate(sorted, Message.ClickedSort({ sort: "fixRate" })).outMessage).toMatchObject({
			url: "/code-review/team?sort=person",
		})
		expect(pageUpdate(sorted, Message.ClickedSort({ sort: "score" })).outMessage).toMatchObject({
			url: "/code-review/team",
		})
	})

	test("everyone is a URL of its own; ranked is the bare page", () => {
		expect(
			pageUpdate(windowed().model, Message.SelectedView({ view: "scorecard" })).outMessage,
		).toMatchObject({
			url: "/code-review/team?ranked=false",
		})
		expect(
			pageUpdate(windowed({ ranked: false }).model, Message.SelectedView({ view: "ranked" }))
				.outMessage,
		).toMatchObject({
			url: "/code-review/team",
		})
	})

	test("the scorecard shows everyone next to the team median, with highlights", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				answered(
					windowed({ ranked: false }).model,
					teamOf([member("ada", 8, 9), member("lin", 2, 3)]),
				),
			),
			expectView(role("row", { name: /Team median/ })).toExist(),
			expectView(role("row", { name: /ada/ })).toExist(),
			expectView(role("row", { name: /lin/ })).toExist(),
			expectView(text("Most findings fixed")).toExist(),
		)
	})

	test("the page opens ranked by score, leaving out people with too few pull requests", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(windowed().model, teamOf([member("ada", 8, 9), member("lin", 2, 3)]))),
			expectView(text("Ranked by score")).toExist(),
			expectView(role("row", { name: /ada/ })).toExist(),
			expectView(role("row", { name: /lin/ })).toBeAbsent(),
			// A count is never a ranking: its header does not sort.
			expectView(role("button", { name: "Merged" })).toBeAbsent(),
			expectView(role("button", { name: "Fixed" })).toExist(),
		)
	})

	test("the activity calendar has a cell per day, named by what happened on it", () => {
		const day = Str.slice(0, 10)(new Date(NOW - 2 * 86_400_000).toISOString())
		scene(
			{ update: pageUpdate, view },
			given(
				answered(
					windowed().model,
					teamOf([member("ada", 8, 9)], 0, [
						{ day, login: "ada", repository: "maple/maple", opened: 2, merged: 1 },
					]),
				),
			),
			expectView(role("grid", { name: "Pull requests opened and merged per day" })).toExist(),
			expectView(role("gridcell", { name: /2 opened, 1 merged/ })).toExist(),
			expectView(text("2 opened and 1 merged in the last 12 months")).toExist(),
		)
	})

	test("an org with no reviews and no CI points at the GitHub integration", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(windowed().model, teamOf([]))),
			expectView(text("No team activity yet")).toExist(),
			expectView(role("link", { name: "Open the GitHub integration" })).toExist(),
		)
	})
})
