import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2SourceWithSecret } from "@maple/domain/http/v2"
import { CloudflareIntegrationStatus } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import * as Tabs from "../../../ui/tabs"
import { type PageContext, PageOutMessage } from "../../contract"
import { Message as IntegrationMessage } from "../../integrations/message"
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
const integrationRoute = (integration: string) => ({ _tag: "SourcesNew" as const, search: { integration } })
/** The integrations module's status reads, which the picker's connected badges come from. */
const STATUS_READS = ["LoadIntegrationsCloudflareStatus", "LoadIntegrationsScrapeTargets"]

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
		kind: "token",
		is_default: false,
		key_prefix: "maple_src_Q7xZa",
		integration_id: null,
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
		health: { status: "pending", last_data_at: null, problem: null, resources: null },
		secret: "maple_src_Q7xZa8Kt7pQ2wR5vN0sL3dJ6hM4gY9dW1",
	})

describe("connect a source", () => {
	test("the picker reads the integration statuses; a push card sets the platform, an integration card its step", () => {
		const entered = init(route(), context)
		expect(names(entered.commands)).toEqual(expect.arrayContaining(STATUS_READS))
		expect(names(entered.commands)).not.toContain("FetchSourcesList")
		scene(
			{ update: pageUpdate, view },
			given(entered.model),
			expectView(text("Step 1 of 3 · Pick what sends the data")).toExist(),
		)
		expect(
			pageUpdate(entered.model, Message.ClickedPushPlatform({ platform: "nodejs" })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/sources/new?platform=nodejs", isReplace: false }),
		)
		expect(
			pageUpdate(entered.model, Message.ClickedIntegration({ integration: "warpstream" })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/sources/new?integration=warpstream",
				isReplace: false,
			}),
		)
	})

	test("the form prefills the platform label and mounts the list", () => {
		const entered = init(route("nodejs"), context)
		expect(names(entered.commands)).toContain("FetchSourcesList")
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
		expect(names(done.commands)).toEqual(
			expect.arrayContaining(["FetchSourcesList", "FetchCreatedSource"]),
		)
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

	test("an integration's step shows its own connect card; an unknown id falls back to the picker", () => {
		const entered = init(integrationRoute("cloudflare"), context)
		expect(entered.model.integration).toBe("cloudflare")
		const status = new CloudflareIntegrationStatus({
			connected: false,
			accountId: null,
			accountName: null,
			connectedByUserId: null,
			scope: null,
			analyticsCapable: false,
			zones: [],
			workers: null,
		})
		const loaded = pageUpdate(
			entered.model,
			Message.GotIntegrationsMessage({
				message: IntegrationMessage.CompletedLoadCloudflare({
					key: entered.model.integrations.statuses.cloudflare.key ?? "",
					result: Result.succeed(status),
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			expectView(text("Step 2 of 3 · Connect Cloudflare")).toExist(),
			expectView(role("button", { name: "Connect Cloudflare" })).toExist(),
			click(role("button", { name: "Pick another source" })),
		)
		expect(pageUpdate(entered.model, Message.ClickedBack()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ url: "/sources/new", isReplace: false }),
		)
		const unknown = init(integrationRoute("slack"), context)
		expect(unknown.model.integration).toBeNull()
		scene(
			{ update: pageUpdate, view },
			given(unknown.model),
			expectView(text("Step 1 of 3 · Pick what sends the data")).toExist(),
		)
	})

	test("once connected, the step links to the source the connect made", () => {
		const entered = init(integrationRoute("cloudflare"), context)
		expect(names(entered.commands)).toContain("FetchSourcesList")
		const status = (connected: boolean) =>
			IntegrationMessage.CompletedLoadCloudflare({
				key: entered.model.integrations.statuses.cloudflare.key ?? "",
				result: Result.succeed(
					new CloudflareIntegrationStatus({
						connected,
						accountId: connected ? "acc" : null,
						accountName: connected ? "Acme" : null,
						connectedByUserId: null,
						scope: null,
						analyticsCapable: true,
						zones: [],
						workers: null,
					}),
				),
			})
		const waiting = pageUpdate(entered.model, Message.GotIntegrationsMessage({ message: status(false) })).model
		const connected = pageUpdate(waiting, Message.GotIntegrationsMessage({ message: status(true) }))
		expect(names(connected.commands)).toContain("FetchSourcesList")
		const row = { ...created(), platform: "cloudflare" as const, key_prefix: null, name: "Cloudflare Acme" }
		const listed = pageUpdate(
			connected.model,
			Message.CompletedFetchList({ key: connected.model.list.key ?? "", result: Result.succeed([row]) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(listed),
			expectView(text("Step 3 of 3 · Collecting")).toExist(),
			expectView(role("link", { name: "Open source" })).toExist(),
		)
	})

	test("from a push form straight to an integration, the step reads the list again", () => {
		const form = init(route("nodejs"), context).model
		const step = routeChanged(form, integrationRoute("cloudflare"), context)
		expect(step.model.platform).toBeNull()
		expect(step.model.integration).toBe("cloudflare")
		expect(names(step.commands)).toContain("FetchSourcesList")
	})

	test("WarpStream finishes once a target is added in this visit, and links to the list", () => {
		const entered = init(integrationRoute("warpstream"), context).model
		expect(entered.hasAddedTarget).toBe(false)
		const added = pageUpdate(
			entered,
			Message.GotIntegrationsMessage({
				message: IntegrationMessage.CompletedSave({ isEdit: false, id: null, failure: null }),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(added),
			expectView(text("Step 3 of 3 · Collecting")).toExist(),
			expectView(role("link", { name: "View sources" })).toExist(),
		)
	})

	test("a target added on another integration's step re-reads the list but does not finish WarpStream", () => {
		const entered = init(integrationRoute("prometheus"), context).model
		const added = pageUpdate(
			entered,
			Message.GotIntegrationsMessage({
				message: IntegrationMessage.CompletedSave({ isEdit: false, id: null, failure: null }),
			}),
		)
		expect(added.model.hasAddedTarget).toBe(false)
		expect(names(added.commands)).toContain("FetchSourcesList")
	})
})
