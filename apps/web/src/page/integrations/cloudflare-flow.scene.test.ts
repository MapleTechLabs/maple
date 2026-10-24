import { OrgId } from "@maple/domain"
import { CloudflareIntegrationStatus } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import type { PageContext } from "../contract"
import { Message } from "../sources/new/message"
import type { Model } from "../sources/new/model"
import { init, update } from "../sources/new/update"
import { view as pageView } from "../sources/new/view"
import { Message as IntegrationMessage } from "./message"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const inner = (model: Model, message: IntegrationMessage) =>
	pageUpdate(model, Message.GotIntegrationsMessage({ message })).model

const NOW = Date.parse("2026-10-01T12:00:00Z")

const zone = (name: string, watermarkAt: number | null) => ({
	id: name,
	name,
	enabled: true,
	lastSyncedAt: watermarkAt,
	lastError: null,
	watermarkAt,
	backfillAt: null,
})

const status = (overrides: Record<string, unknown> = {}) =>
	Schema.decodeUnknownSync(CloudflareIntegrationStatus)({
		connected: true,
		accountId: "acc_1",
		accountName: "Acme",
		connectedByUserId: null,
		scope: "analytics.read",
		analyticsCapable: true,
		connectedAt: NOW,
		zones: [zone("acme.com", null), zone("api.acme.com", null)],
		workers: null,
		...overrides,
	})

const withStatus = (value: CloudflareIntegrationStatus): Model => {
	const entered = init({ _tag: "SourcesNew", search: { integration: "cloudflare" } }, context).model
	return inner(
		inner(entered, IntegrationMessage.CompletedReadClock({ nowMs: NOW })),
		IntegrationMessage.CompletedLoadCloudflare({
			key: entered.integrations.statuses.cloudflare.key ?? "",
			result: Result.succeed(value),
		}),
	)
}

describe("cloudflare connect flow", () => {
	test("before consent, Connect waits on Cloudflare and Continue stays locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status({ connected: false, accountId: null, accountName: null, zones: [] }))),
			expectView(role("listitem", { current: "step", name: "Connect" })).toExist(),
			expectView(role("button", { name: "Connect Cloudflare" })).toExist(),
			expectView(
				text("Not authorized yet. This step completes on its own when you approve in Cloudflare."),
			).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("once authorized, Connect names the account and Go live tracks collection", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status())),
			expectView(text("Authorized. 1 account and 2 zones found.")).toExist(),
			expectView(role("button", { name: "Authorize again" })).toExist(),
			click(role("button", { name: "Continue" })),
			expectView(role("listitem", { name: "Acme" })).toExist(),
			expectView(role("listitem", { current: "step", name: "Go live" })).toExist(),
			expectView(text("Access works")).toExist(),
			expectView(text("Zones found: 2")).toExist(),
			expectView(text("Collecting your first Cloudflare data")).toExist(),
		)
	})

	test("a grant without analytics access asks for an update on Go live", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status({ analyticsCapable: false }))),
			click(role("button", { name: "Continue" })),
			expectView(role("listitem", { name: "Go live: needs attention" })).toExist(),
			expectView(text("Access works: partly")).toExist(),
			expectView(role("button", { name: "Update access" })).toExist(),
		)
	})

	test("zones the poller has caught up on make the source live", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status({ zones: [zone("acme.com", NOW - 60_000)] }))),
			click(role("button", { name: "Continue" })),
			expectView(role("listitem", { name: "Live" })).toExist(),
			expectView(text("Cloudflare is live")).toExist(),
			expectView(text("Backfilled the last 24 hours")).toExist(),
		)
	})
})
