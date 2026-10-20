import { CodeReviewCiAnalytics } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { FrameMessage } from "../kit/frame"
import { context, names, NOW, window } from "../kit/test-fixtures"
import { Message, type Model } from "./model"
import { init, update } from "./update"

type Search = Parameters<typeof init>[0]["search"]

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const resolved = Message.GotFrameMessage({
	message: FrameMessage.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
})
const windowed = (search: Search = {}) => pageUpdate(init({ search }, context).model, resolved)

const totals = (runs: number) => ({
	runs,
	succeeded: runs,
	failed: 0,
	cancelled: 0,
	p50DurationMs: null,
	p95DurationMs: null,
	totalDurationMs: 0,
	jobs: 0,
	p50QueueMs: null,
	p95QueueMs: null,
})
const analyticsOf = (runs: number) =>
	Schema.decodeUnknownSync(CodeReviewCiAnalytics)({
		startTime: NOW - 7 * 86_400_000,
		endTime: NOW,
		bucketSeconds: 86_400,
		current: totals(runs),
		previous: totals(0),
		series: [],
		pipelines: [],
		jobs: [],
	})

const answered = (model: Model, runs: number) =>
	pageUpdate(
		model,
		Message.CompletedFetchAnalytics({
			key: model.analytics.key ?? "",
			result: Result.succeed(analyticsOf(runs)),
		}),
	)

describe("code review CI", () => {
	test("entry reads the analytics once (page and workflow list share it), not the runs yet", () => {
		expect(names(windowed().commands)).toEqual(["FetchCodeReviewCiAnalytics"])
	})

	test("the runs list mounts with the analytics", () => {
		expect(names(answered(windowed().model, 3).commands)).toEqual(["FetchCodeReviewCiRuns"])
	})

	test("an empty window never asks for runs", () => {
		expect(names(answered(windowed().model, 0).commands)).toEqual([])
	})

	test("clicking the selected workflow again clears it", () => {
		const model = windowed({ pipeline: "E2E" }).model
		const again = pageUpdate(model, Message.ClickedWorkflow({ pipeline: "E2E" }))
		expect(again.outMessage).toMatchObject({ url: "/code-review/ci" })
		const other = pageUpdate(model, Message.ClickedWorkflow({ pipeline: "CI" }))
		expect(other.outMessage).toMatchObject({ url: "/code-review/ci?pipeline=CI" })
	})
})
