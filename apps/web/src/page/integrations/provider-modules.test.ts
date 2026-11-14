import { OrgId } from "@maple/domain"
import { RailwayIntegrationStatus, SupabaseIntegrationStatus } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/primitives"
import { Array as Arr, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import * as Field from "@maple/views/ui/field"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { RailwayMessage } from "../infra-integrations/railway/integration/railway"
import { SupabaseMessage } from "../infra-integrations/supabase/integration/supabase"
import { cardStatusOf, overviewOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { RAILWAY_PROVIDER, SUPABASE_PROVIDER } from "./provider-modules"
import { init, update } from "./update"
import { receivedCallback } from "./update-connect"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.parse("2026-10-01T12:00:00Z")
const REF = Schema.decodeSync(SupabaseProjectRef)("abcdefghijklmnopqrst")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const railway = (message: RailwayMessage) => Message.GotRailwayMessage({ message })
const supabase = (message: SupabaseMessage) => Message.GotSupabaseMessage({ message })

const railwayStatus = (firstSyncPending: boolean) =>
	Schema.decodeSync(RailwayIntegrationStatus)({
		connected: true,
		workspaceNames: "Acme",
		connectedByUserId: null,
		connectedAt: NOW,
		authFailed: false,
		lastSyncedAt: NOW,
		lastError: null,
		environments: [
			{
				projectId: "p1",
				projectName: "shop",
				environmentId: "e1",
				environmentName: "production",
				serviceCount: 3,
				enabled: true,
				lastSyncedAt: firstSyncPending ? null : NOW,
				lastError: null,
			},
		],
	})

const supabaseStatus = (connected: boolean) =>
	Schema.decodeSync(SupabaseIntegrationStatus)({
		configured: true,
		connected,
		organization: connected ? { id: "org-1", slug: "acme", name: "Acme" } : null,
		connectedByUserId: null,
		connectedAt: null,
		revoked: false,
		lastDiscoveryAt: null,
		lastDiscoveryError: null,
		projects: [],
	})

const withRailway = (search: Model["search"], status: RailwayIntegrationStatus): Model => {
	const model = init({ search }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadRailway({
			key: model.statuses.railway.key ?? "",
			result: Result.succeed(status),
		}),
	).model
}

const withSupabase = (search: Model["search"], status: SupabaseIntegrationStatus): Model => {
	const model = init({ search }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadSupabase({
			key: model.statuses.supabase.key ?? "",
			result: Result.succeed(status),
		}),
	).model
}

describe("provider modules", () => {
	test("a module's message changes only its own slot", () => {
		const model = init({ search: { integration: "railway" } }, context).model
		const next = pageUpdate(
			model,
			railway(
				RailwayMessage.GotTokenMessage({
					message: Field.Message.ChangedValue({ value: "rw_token" }),
				}),
			),
		).model
		expect(next.railwayCard.connect.token.value).toBe("rw_token")
		expect(next.supabaseCard).toBe(model.supabaseCard)
		expect(next.statuses).toBe(model.statuses)
		expect(next.connect).toBe(model.connect)
	})

	test("a module's hub requests run before its own commands", () => {
		const model = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		const toggled = pageUpdate(
			model,
			supabase(SupabaseMessage.ToggledSwitch({ ref: REF, kind: "logs", enabled: true })),
		)
		expect(names(toggled.commands)).toEqual(["SetSupabaseProjectLogs"])
		const saved = pageUpdate(
			toggled.model,
			supabase(
				SupabaseMessage.CompletedSwitch({ ref: REF, kind: "logs", enabled: true, failure: null }),
			),
		)
		const sent = names(saved.commands)
		expect(sent).toContain("ReadSupabaseClock")
		expect(sent.indexOf("LoadIntegrationsSupabaseStatus")).toBeLessThan(sent.indexOf("ReadSupabaseClock"))
		expect(sent.indexOf("LoadIntegrationsSupabaseStatus")).toBeGreaterThanOrEqual(0)
	})

	test("a module's toast request reaches the page as its OutMessage", () => {
		const model = withRailway({ integration: "railway" }, railwayStatus(false))
		const failure = toLoadFailure(new Error("down"))
		const failed = pageUpdate(model, railway(RailwayMessage.CompletedSync({ failure })))
		expect(failed.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "error",
				title: "Couldn't sync Railway",
				description: failure.message,
			}),
		)
		expect(names(failed.commands)).toEqual([])
	})

	test("a clock reading the module took sets the page's clock", () => {
		const model = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		const read = pageUpdate(model, supabase(SupabaseMessage.CompletedReadClock({ nowMs: NOW })))
		expect(read.model.nowMs).toBe(NOW)
		expect(names(read.commands)).toEqual(["LoadIntegrationsSupabaseMetrics"])
	})

	test("Railway's first-sync poll runs only on its own card while an environment waits", () => {
		const ticker = RAILWAY_PROVIDER.ticker
		expect(ticker?.isActive(withRailway({ integration: "railway" }, railwayStatus(true)))).toBe(true)
		expect(ticker?.isActive(withRailway({ integration: "railway" }, railwayStatus(false)))).toBe(false)
		expect(ticker?.isActive(withRailway({}, railwayStatus(true)))).toBe(false)
	})

	test("Supabase's card clock ticks only while the connected card shows, and its tick reads the page clock", () => {
		const shown = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		const ticker = SUPABASE_PROVIDER.ticker
		expect(ticker?.isActive(shown)).toBe(true)
		expect(ticker?.isActive(withSupabase({ integration: "supabase" }, supabaseStatus(false)))).toBe(false)
		expect(ticker?.isActive(withSupabase({}, supabaseStatus(true)))).toBe(false)
		expect(ticker === null ? [] : names(pageUpdate(shown, ticker.tick).commands)).toEqual([
			"ReadIntegrationsClock",
		])
	})

	test("a successful connect runs the connected hook of that provider's module only", () => {
		const supabaseModel = withSupabase({ integration: "supabase" }, supabaseStatus(true))
		expect(
			names(receivedCallback(supabaseModel, context, "supabase", "success", null).commands),
		).toContain("SyncSupabase")
		const linearModel = init({ search: { integration: "linear" } }, context).model
		expect(
			names(receivedCallback(linearModel, context, "linear", "success", null).commands),
		).not.toContain("SyncSupabase")
	})

	test("the header badge and catalog row of a module come from the module", () => {
		const statuses = withRailway({}, railwayStatus(true)).statuses
		expect(cardStatusOf(statuses, "railway", NOW)).toEqual({ label: "1 environment", variant: "ok" })
		expect(overviewOf(statuses, NOW, "railway")).toMatchObject({
			kind: "connected",
			context: "Acme",
			stat: "1 environment polled",
		})
	})
})
