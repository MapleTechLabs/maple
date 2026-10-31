import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2Recommendation } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { click, Command, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import { type PageContext, PageOutMessage } from "../contract"
import { DismissRecommendation, FetchRecommendations } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const ORG = "org_parity"
const UUID = "0199a062-0000-7000-8000-000000000003"
const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const rec = (status: "open" | "dismissed" = "open") =>
	Schema.decodeUnknownSync(V2Recommendation)({
		id: encodePublicId(PublicIdPrefixes.recommendation, UUID),
		object: "recommendation",
		number: 3,
		recommendation_key: "rename:peer.service",
		kind: "rename",
		source_key: "peer.service",
		canonical_key: "service.peer.name",
		status,
		usage_count: 41_027,
		opened_at: "2026-09-26T12:00:00.000Z",
		updated_at: "2026-10-01T09:00:00.000Z",
		resolved_at: null,
	})

const route = (recommendationKey = UUID) => ({ _tag: "Recommendation" as const, recommendationKey })

const loaded = (rows: ReadonlyArray<V2Recommendation>, key = UUID): Model => {
	const entered = init(route(key), context).model
	return [Message.ReadClock({ nowMs: Date.UTC(2026, 9, 1, 12) }), Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed(rows) })].reduce(
		(model, message) => pageUpdate(model, message).model,
		entered,
	)
}

describe("recommendation detail", () => {
	test("entry reads the clock, the recommendations and the attribute mappings", () => {
		expect(names(init(route(), context).commands)).toEqual(
			expect.arrayContaining([
				"ReadRecommendationClock",
				"FetchRecommendations",
				"FetchRecommendationAttributeMappings",
			]),
		)
	})

	test("an unknown key says so and links back to the ingestion settings", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([rec()], "0199a062-0000-7000-8000-0000000000ff")),
			expectView(text("Recommendation not found")).toExist(),
			expectView(role("link", { name: "Back to recommendations" })).toHaveAttr("href", "/settings?tab=ingestion"),
		)
	})

	test("a failed list renders the error state; a stale answer is dropped", () => {
		const entered = init(route(), context).model
		const stale = pageUpdate(entered, Message.CompletedFetchList({ key: "other", result: Result.succeed([rec()]) })).model
		expect(stale.list).toEqual(entered.list)
		const failed = pageUpdate(
			entered,
			Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.fail(toLoadFailure(new Error("boom"))) }),
		).model
		scene({ update: pageUpdate, view }, given(failed), expectView(text("Couldn't load recommendation")).toExist())
	})

	test("Dismiss sends one request and refreshes the list", () => {
		const model = loaded([rec()])
		const reread = pageUpdate(pageUpdate(model, Message.ClickedDismiss()).model, Message.CompletedDismiss({ result: Result.succeed(undefined) }))
		scene(
			{ update: pageUpdate, view },
			given(model),
			click(role("button", { name: "Dismiss recommendation" })),
			Command.resolve(DismissRecommendation, Message.CompletedDismiss({ result: Result.succeed(undefined) })),
			Command.resolve(
				FetchRecommendations,
				Message.CompletedFetchList({ key: reread.model.list.key ?? "", result: Result.succeed([rec("dismissed")]) }),
			),
			expectView(role("button", { name: "Reopen recommendation" })).toExist(),
		)
		const started = pageUpdate(model, Message.ClickedDismiss())
		expect(names(started.commands)).toEqual(["DismissRecommendation"])
		expect(pageUpdate(started.model, Message.ClickedApply()).commands ?? []).toHaveLength(0)
	})

	test("a write's re-read is sent even while a list read is in flight, and only its answer lands", () => {
		const reading = pageUpdate(loaded([rec()]), Message.ClickedRetry()).model
		const started = pageUpdate(reading, Message.ClickedDismiss()).model
		const reread = pageUpdate(started, Message.CompletedDismiss({ result: Result.succeed(undefined) }))
		expect(names(reread.commands)).toEqual(["FetchRecommendations"])
		const late = pageUpdate(reread.model, Message.CompletedFetchList({ key: reading.list.key ?? "", result: Result.succeed([rec()]) })).model
		expect(late.list).toEqual(reread.model.list)
	})

	test("a failed apply toasts and clears the busy state", () => {
		const started = pageUpdate(loaded([rec()]), Message.ClickedApply())
		expect(names(started.commands)).toEqual(["CreateRecommendationMapping"])
		const failed = pageUpdate(started.model, Message.CompletedApply({ result: Result.fail(toLoadFailure(new Error("no"))) }))
		expect(failed.model.busy).toBeNull()
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "error", title: "Couldn't create mapping", description: toLoadFailure(new Error("no")).message }),
		)
		scene({ update: pageUpdate, view }, given(failed.model), expectView(role("button", { name: "Apply mapping" })).toBeEnabled())
	})
})
