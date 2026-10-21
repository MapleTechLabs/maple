import { OrgId } from "@maple/domain"
import { SupabaseIntegrationStatus } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { overviewOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { projectStatusLabel } from "./supabase"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const REF = Schema.decodeSync(SupabaseProjectRef)("abcdefghijklmnopqrst")
const PAUSED_REF = Schema.decodeSync(SupabaseProjectRef)("pausedprojectabcdefg")

const status = (overrides: Record<string, unknown> = {}) =>
	Schema.decodeUnknownSync(SupabaseIntegrationStatus)({
		configured: true,
		connected: true,
		organization: { id: "org-1", slug: "acme", name: "Acme" },
		connectedByUserId: null,
		connectedAt: 1_760_000_000_000,
		revoked: false,
		lastDiscoveryAt: 1_760_000_000_000,
		lastDiscoveryError: null,
		projects: [
			{
				ref: REF,
				name: "storefront",
				region: "eu-central-1",
				status: "ACTIVE_HEALTHY",
				metricsEnabled: true,
				logDrainEnabled: false,
				lastSeenAt: 1_760_000_000_000,
			},
			{
				ref: PAUSED_REF,
				name: "sandbox",
				region: "us-east-1",
				status: "INACTIVE",
				metricsEnabled: false,
				logDrainEnabled: false,
				lastSeenAt: 1_760_000_000_000,
			},
		],
		...overrides,
	})

const withStatus = (value: SupabaseIntegrationStatus): Model => {
	const model = init({ search: { integration: "supabase" } }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadSupabase({
			key: model.statuses.supabase.key ?? "",
			result: Result.succeed(value),
		}),
	).model
}

describe("supabase card", () => {
	test("a disconnected organization offers the OAuth connect", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status({ connected: false, organization: null, projects: [] }))),
			expectView(role("button", { name: "Connect Supabase" })).toExist(),
		)
	})

	test("a deployment without the OAuth app explains it and offers no connect", () => {
		const model = withStatus(
			status({ configured: false, connected: false, organization: null, projects: [] }),
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Supabase isn't configured on this deployment.")).toExist(),
			expectView(role("button", { name: "Connect Supabase" })).toBeAbsent(),
		)
		expect(overviewOf(model.statuses, model.nowMs, "supabase")).toEqual({ kind: "unavailable" })
	})

	test("a connected organization lists its projects with a metrics switch and a paused pill", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status())),
			expectView(text("storefront")).toExist(),
			expectView(role("switch", { name: "Collect metrics for storefront" })).toExist(),
			expectView(text("Paused")).toExist(),
			expectView(role("button", { name: "Sync now" })).toExist(),
		)
	})

	test("revoked access asks to reconnect and reads as needing attention", () => {
		const model = withStatus(status({ revoked: true }))
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("button", { name: "Reconnect" })).toExist(),
			expectView(text("Access revoked")).toExist(),
		)
		const overview = overviewOf(model.statuses, model.nowMs, "supabase")
		expect(overview?.kind === "connected" ? overview.issue : null).toBe("Reconnect to resume")
	})

	test("a metrics switch writes once per project until its answer, then re-reads the status", () => {
		const model = withStatus(status())
		const sent = pageUpdate(model, Message.ToggledSupabaseMetrics({ ref: REF, enabled: false }))
		expect(names(sent.commands)).toEqual(["SetSupabaseProjectMetrics"])
		expect(
			names(
				pageUpdate(sent.model, Message.ToggledSupabaseMetrics({ ref: REF, enabled: false })).commands,
			),
		).toEqual([])
		const done = pageUpdate(
			sent.model,
			Message.CompletedSupabaseMetrics({ ref: REF, enabled: false, failure: null }),
		)
		expect(done.model.supabaseCard.pendingRefs).toEqual([])
		expect(names(done.commands)).toEqual(["LoadIntegrationsSupabaseStatus"])
	})

	test("a successful connect syncs the projects, then re-reads the status", () => {
		const connected = pageUpdate(
			withStatus(status({ connected: false, organization: null, projects: [] })),
			Message.ReceivedConnectMessage({ provider: "supabase", status: "success", message: null }),
		)
		expect(names(connected.commands)).toContain("SyncSupabase")
		expect(connected.model.supabaseCard.isSyncing).toBe(true)
		const synced = pageUpdate(connected.model, Message.CompletedSupabaseSync({ failure: null }))
		expect(synced.model.supabaseCard.isSyncing).toBe(false)
		expect(names(synced.commands)).toEqual(["LoadIntegrationsSupabaseStatus"])
	})

	test("a failed sync toasts and still re-reads the status", () => {
		const syncing = pageUpdate(withStatus(status()), Message.ClickedSupabaseSync())
		const failed = pageUpdate(
			syncing.model,
			Message.CompletedSupabaseSync({ failure: toLoadFailure("boom") }),
		)
		expect(failed.model.supabaseCard.isSyncing).toBe(false)
		expect(names(failed.commands)).toEqual(["LoadIntegrationsSupabaseStatus"])
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Failed to sync Supabase",
				description: toLoadFailure("boom").message,
			}),
		)
	})

	test("a failed metrics write frees the switch and toasts", () => {
		const sent = pageUpdate(
			withStatus(status()),
			Message.ToggledSupabaseMetrics({ ref: REF, enabled: true }),
		)
		const failed = pageUpdate(
			sent.model,
			Message.CompletedSupabaseMetrics({ ref: REF, enabled: true, failure: toLoadFailure("boom") }),
		)
		expect(failed.model.supabaseCard.pendingRefs).toEqual([])
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Failed to start collecting metrics",
				description: toLoadFailure("boom").message,
			}),
		)
	})
})

describe("projectStatusLabel", () => {
	test("reads Supabase's lifecycle statuses", () => {
		expect(projectStatusLabel("ACTIVE_HEALTHY")).toBeNull()
		expect(projectStatusLabel("INACTIVE")).toEqual({ label: "Paused", tone: "warn" })
		expect(projectStatusLabel("COMING_UP")).toEqual({ label: "Coming up", tone: "warn" })
		expect(projectStatusLabel("RESTORE_FAILED")).toEqual({ label: "Restore failed", tone: "crit" })
	})
})
