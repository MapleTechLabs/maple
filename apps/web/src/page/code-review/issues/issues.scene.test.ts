import { CodeReviewFindingsResponse, PrReviewId } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Select from "../../../ui/select"
import { FrameMessage } from "../kit/frame"
import { context, names, NOW, window } from "../kit/test-fixtures"
import { Message, type Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

type Search = Parameters<typeof init>[0]["search"]

const REVIEW = Schema.decodeSync(PrReviewId)("00000c02-0000-4000-8000-000000000001")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const resolved = Message.GotFrameMessage({
	message: FrameMessage.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
})
const windowed = (search: Search = {}) => pageUpdate(init({ search }, context).model, resolved)
const noFindings = Schema.decodeUnknownSync(CodeReviewFindingsResponse)({ findings: [], nextCursor: null })

describe("code review issues", () => {
	test("entry reads the findings and the author list", () => {
		expect(names(windowed().commands)).toEqual(
			expect.arrayContaining(["FetchCodeReviewFindings", "FetchCodeReviewFindingAuthors"]),
		)
	})

	test("picking a severity puts it in the URL", () => {
		const model = windowed().model
		const picked = pageUpdate(
			model,
			Message.GotFilterSelectMessage({
				filter: "severity",
				message: Select.Message.SelectedItem({ index: 1, value: "critical" }),
			}),
		)
		expect(picked.outMessage).toMatchObject({ url: "/code-review/issues?severity=critical" })
	})

	test("the severity filter sends the narrowed read, the author list stays", () => {
		const model = windowed().model
		const narrowed = routeChanged(model, { search: { severity: "critical" } }, context)
		expect(names(narrowed.commands)).toEqual(["FetchCodeReviewFindings"])
		expect(narrowed.model.findings.key).toContain('"severity":"critical"')
	})

	test("a finding opens its review in the sheet", () => {
		const opened = pageUpdate(windowed().model, Message.ClickedFinding({ reviewId: REVIEW }))
		expect(opened.outMessage).toMatchObject({ url: `/code-review/issues?review=${REVIEW}` })
	})

	test("filtered to nothing, the list offers to clear the filters", () => {
		const model = windowed({ state: "dismissed" }).model
		const answered = pageUpdate(
			model,
			Message.CompletedFetchFindings({
				key: model.findings.key ?? "",
				result: Result.succeed(noFindings),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(answered),
			expectView(text("No issues in this window")).toExist(),
			expectView(role("button", { name: "Clear filters" })).toExist(),
		)
	})
})
