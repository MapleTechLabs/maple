import { CodeReviewCiAnalytics, CodeReviewCiRun } from "@maple/domain/http"
import { Result, Schema } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { expect as expectView, given, role, scene } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { FrameMessage } from "../kit/frame"
import { traceKept, traceLink } from "../kit/parts"
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

describe("a CI run's trace link", () => {
	const DAY_MS = 86_400_000
	const runAt = (startedAt: number) =>
		Schema.decodeUnknownSync(CodeReviewCiRun)({
			traceId: "0af7651916cd43dd8448eb211c80319c",
			pipeline: "CI",
			repository: "web",
			branch: "main",
			revision: "abc123",
			runId: "1",
			attempt: 1,
			trigger: "push",
			actor: "ada",
			pullRequest: null,
			result: "success",
			durationMs: 60_000,
			startedAt,
			url: "https://github.com/acme/web/actions/runs/1",
			failedJobs: [],
		})
	const config = {
		update: (startedAt: number, _message: never) => ({ model: startedAt }),
		view: (startedAt: number, h: HtmlBuilder<never>) => h.div([], traceLink(h, runAt(startedAt), NOW)),
	}

	test("opens the trace while traces still keep it, and is gone after", () => {
		scene(config, given(NOW - 29 * DAY_MS), expectView(role("link", { name: "View trace" })).toExist())
		scene(config, given(NOW - 60 * DAY_MS), expectView(role("link", { name: "View trace" })).toBeAbsent())
	})
})

describe("traceKept", () => {
	test("a run's trace expires with its UTC day, 30 days on", () => {
		const startedAt = Date.UTC(2026, 9, 1, 23)
		expect(traceKept(startedAt, Date.UTC(2026, 9, 30, 23, 59))).toBe(true)
		expect(traceKept(startedAt, Date.UTC(2026, 9, 31))).toBe(false)
	})
})
