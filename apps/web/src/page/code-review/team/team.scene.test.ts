import { CodeReviewTeam } from "@maple/domain/http"
import { Result, Schema } from "effect"
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

const teamOf = (members: ReadonlyArray<ReturnType<typeof member>>, runnerMs = 0) =>
	Schema.decodeUnknownSync(CodeReviewTeam)({
		startTime: NOW - 30 * 86_400_000,
		endTime: NOW,
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
			url: "/code-review/team",
		})
	})

	test("the ranked view is a URL of its own", () => {
		expect(
			pageUpdate(windowed().model, Message.SelectedView({ view: "ranked" })).outMessage,
		).toMatchObject({
			url: "/code-review/team?ranked=true",
		})
	})

	test("the scorecard shows everyone next to the team median, with highlights", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(windowed().model, teamOf([member("ada", 8, 9), member("lin", 2, 3)]))),
			expectView(role("row", { name: /Team median/ })).toExist(),
			expectView(role("row", { name: /ada/ })).toExist(),
			expectView(role("row", { name: /lin/ })).toExist(),
			expectView(text("Most findings fixed")).toExist(),
		)
	})

	test("ranked leaves out people with too few pull requests and numbers the rest", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				answered(
					windowed({ ranked: true }).model,
					teamOf([member("ada", 8, 9), member("lin", 2, 3)]),
				),
			),
			expectView(text("Ranked by fix rate")).toExist(),
			expectView(role("row", { name: /ada/ })).toExist(),
			expectView(role("row", { name: /lin/ })).toBeAbsent(),
			// A count is never a ranking: its header does not sort.
			expectView(role("button", { name: "Merged" })).toBeAbsent(),
			expectView(role("button", { name: "Fixed" })).toExist(),
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
