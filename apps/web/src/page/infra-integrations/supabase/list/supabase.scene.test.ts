import { OrgId } from "@maple/domain"
import { SupabaseIntegrationStatus } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../../contract"
import type { SupabaseProjectRow } from "../model"
import { projectViews } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-01 06:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = 1_790_000_000_000

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const project = (ref: string, name: string, metricsEnabled: boolean) => ({
	ref,
	name,
	region: "eu-central-1",
	status: "ACTIVE_HEALTHY",
	metricsEnabled,
	logDrainEnabled: false,
	logsEnabled: false,
	logsLastPolledAt: null,
	logsError: null,
	lastSeenAt: NOW,
})

const status = (connected: boolean) =>
	Schema.decodeUnknownSync(SupabaseIntegrationStatus)({
		configured: true,
		connected,
		organization: connected ? { id: "o1", slug: "acme", name: "Acme" } : null,
		connectedByUserId: null,
		connectedAt: null,
		revoked: false,
		lastDiscoveryAt: NOW,
		lastDiscoveryError: null,
		projects: connected
			? [
					project("storefrontaaaaaaaaaa", "storefront", true),
					project("newprojectaaaaaaaaaa", "new-project", true),
					project("sandboxaaaaaaaaaaaaa", "sandbox", false),
				]
			: [],
	})

const row = (projectRef: string): SupabaseProjectRow => ({
	projectRef,
	cpuAvg: 0.2,
	cpuMax: 0.35,
	memoryAvg: 0.5,
	memoryMax: 0.62,
	memoryTotal: 1e9,
	diskUsedMax: 0.14,
	diskSize: 8e9,
	dbSize: 10_802_867,
	connectionsAvg: 5,
	connectionsMax: 7,
	lastSeen: "2026-10-01 12:00:00",
})

const steps = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => pageUpdate(current, message).model, model)

const withStatus = (connected: boolean): Model => {
	const entered = init({ search: {} }, context).model
	const windowed = steps(entered, [Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" })])
	return steps(windowed, [
		Message.CompletedLoadStatus({
			key: windowed.status.key ?? "",
			result: Result.succeed(status(connected)),
		}),
	])
}

describe("supabase list", () => {
	test("not connected is the connect on-ramp and reads no metrics", () => {
		const entered = init({ search: {} }, context).model
		const windowed = pageUpdate(
			entered,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		const answered = pageUpdate(
			windowed.model,
			Message.CompletedLoadStatus({
				key: windowed.model.status.key ?? "",
				result: Result.succeed(status(false)),
			}),
		)
		expect(names(answered.commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(answered.model),
			expectView(role("link", { name: "Connect Supabase" })).toExist(),
			expectView(text("Peak use")).toBeAbsent(),
		)
	})

	test("a connected organization reads its projects' metrics for the window", () => {
		const entered = init({ search: {} }, context).model
		const windowed = steps(entered, [
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		])
		const answered = pageUpdate(
			windowed,
			Message.CompletedLoadStatus({
				key: windowed.status.key ?? "",
				result: Result.succeed(status(true)),
			}),
		)
		expect(names(answered.commands)).toEqual(["FetchSupabaseProjects"])
	})

	test("each project says whether it is collecting, waiting for a first scrape or switched off", () => {
		const model = withStatus(true)
		const loaded = steps(model, [
			Message.CompletedFetchProjects({
				key: model.projects.key ?? "",
				result: Result.succeed([row("storefrontaaaaaaaaaa")]),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			expectView(role("link", { name: /storefront/ })).toExist(),
			expectView(text("Waiting for the first scrape")).toExist(),
			expectView(text("Not collected")).toExist(),
		)
	})
})

describe("projectViews", () => {
	test("keeps a project that still has metrics after discovery dropped it", () => {
		const views = projectViews(status(true), [row("goneprojectaaaaaaaaa")])
		expect(views.map((view) => [view.ref, view.collection])).toEqual([
			["storefrontaaaaaaaaaa", "waiting"],
			["newprojectaaaaaaaaaa", "waiting"],
			["sandboxaaaaaaaaaaaaa", "off"],
			["goneprojectaaaaaaaaa", "collecting"],
		])
	})
})
