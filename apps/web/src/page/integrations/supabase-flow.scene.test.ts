import { OrgId } from "@maple/domain"
import { SupabaseIntegrationStatus } from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import type { SupabaseProjectRow } from "../infra-integrations/supabase/model"
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

const REF = Schema.decodeSync(SupabaseProjectRef)("abcdefghijklmnopqrst")
const NOW = Date.parse("2026-10-01T12:00:00Z")

const project = (overrides: Record<string, unknown> = {}) => ({
	ref: REF,
	name: "storefront",
	region: "eu-central-1",
	status: "ACTIVE_HEALTHY",
	metricsEnabled: false,
	logDrainEnabled: false,
	logDrainError: null,
	logDrainSourceId: null,
	logDrains: [],
	logDrainsCheckedAt: null,
	logsEnabled: false,
	logsLastPolledAt: null,
	logsError: null,
	lastSeenAt: NOW,
	...overrides,
})

const status = (overrides: Record<string, unknown> = {}) =>
	Schema.decodeUnknownSync(SupabaseIntegrationStatus)({
		configured: true,
		connected: true,
		organization: { id: "org-1", slug: "acme", name: "Acme" },
		connectedByUserId: null,
		connectedAt: NOW,
		revoked: false,
		lastDiscoveryAt: NOW,
		lastDiscoveryError: null,
		projects: [project()],
		...overrides,
	})

const withStatus = (value: SupabaseIntegrationStatus): Model => {
	const entered = init({ _tag: "SourcesNew", search: { integration: "supabase" } }, context).model
	return inner(
		inner(entered, IntegrationMessage.CompletedReadClock({ nowMs: NOW })),
		IntegrationMessage.CompletedLoadSupabase({
			key: entered.integrations.statuses.supabase.key ?? "",
			result: Result.succeed(value),
		}),
	)
}

const withRows = (model: Model, rows: ReadonlyArray<SupabaseProjectRow>): Model =>
	inner(
		model,
		IntegrationMessage.CompletedLoadSupabaseMetrics({
			key: model.integrations.supabaseCard.metrics.key ?? "",
			result: Result.succeed(rows),
		}),
	)

const row = (lastSeen: string): SupabaseProjectRow => ({
	projectRef: REF,
	cpuAvg: 0.2,
	cpuMax: 0.3,
	memoryAvg: 0.5,
	memoryMax: 0.6,
	memoryTotal: 2 * 1024 ** 3,
	diskUsedMax: 0.3,
	diskSize: 8e9,
	dbSize: 1e7,
	connectionsAvg: 10,
	connectionsMax: 20,
	maxConnections: 90,
	requests: 1000,
	requestsPerMinute: 16,
	errors5xx: 0,
	issueCount: 0,
	lastSeen,
})

describe("supabase connect flow", () => {
	test("before the grant, Connect opens Supabase and Continue waits", () => {
		const model = withStatus(status({ connected: false, organization: null, projects: [] }))
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("listitem", { current: "step", name: "Connect" })).toExist(),
			expectView(
				text("Not authorized yet. This step completes on its own when you approve in Supabase."),
			).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
			click(role("button", { name: "Continue with Supabase" })),
			expectView(text("Waiting for you to approve in Supabase")).toExist(),
			expectView(text("Waiting for Supabase.")).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("a deployment without the OAuth app says so and offers no sign-in", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				withStatus(status({ configured: false, connected: false, organization: null, projects: [] })),
			),
			expectView(text("Supabase isn't configured on this deployment.")).toExist(),
			expectView(role("button", { name: "Continue with Supabase" })).toBeAbsent(),
		)
	})

	test("the grant names its organization; Choose data waits for a switched-on project", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status())),
			expectView(text("Connected to Acme. Maple can list its 1 project.")).toExist(),
			click(role("button", { name: "Continue" })),
			expectView(role("listitem", { current: "step", name: "Choose data" })).toExist(),
			expectView(role("listitem", { name: "Acme" })).toExist(),
			expectView(role("switch", { name: "Collect metrics for storefront" })).toBeEnabled(),
			expectView(text("Turn on at least one project to continue.")).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("flipping a switch writes it from Choose data", () => {
		const choosing = pageUpdate(withStatus(status()), Message.ClickedContinue()).model
		const flipped = pageUpdate(
			choosing,
			Message.GotIntegrationsMessage({
				message: IntegrationMessage.ToggledSupabaseMetrics({ ref: REF, enabled: true }),
			}),
		)
		expect((flipped.commands ?? []).map(({ name }) => name)).toContain("SetSupabaseProjectMetrics")
		scene(
			{ update: pageUpdate, view },
			given(flipped.model),
			expectView(role("switch", { name: "Collect metrics for storefront" })).toBeDisabled(),
		)
	})

	test("Go live waits for the first metrics, then reads live", () => {
		const collecting = withStatus(status({ projects: [project({ metricsEnabled: true })] }))
		const live = (model: Model) =>
			pageUpdate(pageUpdate(model, Message.ClickedContinue()).model, Message.ClickedContinue()).model
		scene(
			{ update: pageUpdate, view },
			given(live(withRows(collecting, []))),
			expectView(role("listitem", { current: "step", name: "Go live" })).toExist(),
			expectView(text("Access works")).toExist(),
			expectView(text("0 of 1 projects reporting · usually under 2 minutes")).toExist(),
			expectView(role("link", { name: "View sources" })).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(live(withRows(collecting, [row("2026-10-01 11:59:37")]))),
			expectView(role("listitem", { name: "Live" })).toExist(),
			expectView(text("1 of 1 projects reporting CPU, memory, disk and Postgres")).toExist(),
		)
	})

	test("a broken drain reads as needing attention on Go live", () => {
		const model = withStatus(
			status({ projects: [project({ logDrainEnabled: true, logDrainError: "Drain rejected" })] }),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(pageUpdate(model, Message.ClickedContinue()).model, Message.ClickedContinue())
					.model,
			),
			expectView(role("listitem", { current: "step", name: "Go live: needs attention" })).toExist(),
			expectView(text("storefront: Drain rejected")).toExist(),
		)
	})

	test("revoked access asks to reconnect and keeps Continue closed", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status({ revoked: true }))),
			expectView(text("Access revoked")).toExist(),
			expectView(role("button", { name: "Reconnect with Supabase" })).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})
})
