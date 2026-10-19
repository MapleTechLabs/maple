import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2SourceWithSecret } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import * as Tabs from "../../../ui/tabs"
import { type PageContext, PageOutMessage } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = { orgId: Schema.decodeSync(OrgId)("org_parity"), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)
const route = (platform?: "nodejs" | "kubernetes") => ({
	_tag: "SourcesNew" as const,
	search: platform === undefined ? {} : { platform },
})

/** The setup's snippet tabs measure their indicator on mount. */
const indicatorMeasured = () =>
	Mount.resolve<string, Tabs.Message>(
		Tabs.MeasureTabIndicator,
		Tabs.Message.MeasuredIndicator({ rect: { left: 0, right: 96, top: 0, bottom: 32, width: 96, height: 32 } }),
	)

const created = (lastUsedAt: string | null = null) =>
	Schema.decodeUnknownSync(V2SourceWithSecret)({
		id: encodePublicId(PublicIdPrefixes.source, "0199a0e1-0000-7000-8000-000000000010"),
		object: "source",
		name: "Node.js",
		description: null,
		platform: "nodejs",
		is_default: false,
		key_prefix: "maple_src_Q7xZa",
		status: "active",
		allowed_signals: null,
		rate_limit_rps: null,
		resource_attributes: [],
		expires_at: null,
		paused_at: null,
		paused_until: null,
		last_used_at: lastUsedAt,
		rolled_at: "2026-10-01T00:00:00.000Z",
		created_at: "2026-10-01T00:00:00.000Z",
		updated_at: "2026-10-01T00:00:00.000Z",
		health: { status: "pending", last_data_at: null, problem: null },
		secret: "maple_src_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1",
	})

describe("connect a source", () => {
	test("the picker reads nothing; a push card sets the platform, a pull card opens its integration", () => {
		const entered = init(route(), context)
		expect(entered.commands ?? []).toHaveLength(0)
		scene({ update: pageUpdate, view }, given(entered.model), expectView(text("Step 1 of 3 · Pick what sends the data")).toExist())
		expect(pageUpdate(entered.model, Message.ClickedPushPlatform({ platform: "nodejs" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/sources/new?platform=nodejs", isReplace: false }),
		)
		expect(pageUpdate(entered.model, Message.ClickedPullPlatform({ platform: "prometheus" })).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/integrations?integration=prometheus", isReplace: false }),
		)
	})

	test("the form prefills the platform label and mounts the list", () => {
		const entered = init(route("nodejs"), context)
		expect(names(entered.commands)).toEqual(["FetchSourcesList"])
		expect(entered.model.name).toBe("Node.js")
		scene(
			{ update: pageUpdate, view },
			given(entered.model),
			expectView(text("Step 2 of 3 · Name it")).toExist(),
			click(role("button", { name: "Advanced" })),
			expectView(text("Resource attributes")).toExist(),
		)
		const back = routeChanged(entered.model, route(), context)
		expect(back.model.platform).toBeNull()
		expect(names(routeChanged(back.model, route("kubernetes"), context).commands)).toEqual(["FetchSourcesList"])
	})

	test("an empty name disables Create; a failed create toasts and re-enables it", () => {
		const entered = init(route("nodejs"), context).model
		const blank = pageUpdate(entered, Message.ChangedName({ value: "  " })).model
		expect(pageUpdate(blank, Message.SubmittedForm()).commands ?? []).toHaveLength(0)
		const started = pageUpdate(entered, Message.SubmittedForm())
		expect(names(started.commands)).toEqual(["CreateSource"])
		const failure = toLoadFailure(new Error("no"))
		const failed = pageUpdate(started.model, Message.CompletedCreate({ result: Result.fail(failure) }))
		expect(failed.model.isSaving).toBe(false)
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "error", title: "Failed to create source", description: failure.message }),
		)
	})

	test("a create shows the token, refreshes the list and polls until data arrives", () => {
		const started = pageUpdate(init(route("nodejs"), context).model, Message.SubmittedForm()).model
		const done = pageUpdate(started, Message.CompletedCreate({ result: Result.succeed(created()) }))
		expect(names(done.commands)).toEqual(["FetchSourcesList", "FetchCreatedSource"])
		scene(
			{ update: pageUpdate, view },
			given(done.model),
			indicatorMeasured(),
			expectView(text("Step 3 of 3 · Send data")).toExist(),
			expectView(text("Waiting for first data")).toExist(),
			expectView(role("link", { name: "Skip for now" })).toExist(),
		)
		const key = done.model.firstData.key ?? ""
		const pending = pageUpdate(done.model, Message.CompletedFetchSource({ key, result: Result.succeed(created()) }))
		expect(names(pending.commands)).toEqual(["WaitFirstDataPoll"])
		expect(names(pageUpdate(pending.model, Message.ElapsedPoll({ key })).commands)).toEqual(["FetchCreatedSource"])
		const receiving = pageUpdate(done.model, Message.CompletedFetchSource({ key, result: Result.succeed(created("2026-10-01T00:01:00.000Z")) }))
		expect(receiving.commands ?? []).toHaveLength(0)
		expect(pageUpdate(receiving.model, Message.ElapsedPoll({ key })).commands ?? []).toHaveLength(0)
		scene({ update: pageUpdate, view }, given(receiving.model), indicatorMeasured(), expectView(role("link", { name: "Open source" })).toExist())
	})
})
