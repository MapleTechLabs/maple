import { OrgId } from "@maple/domain"
import {
	SupabaseIntegrationStatus,
	SupabaseLogIssuesResponse,
	SupabaseProjectInsights,
} from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../../contract"
import type { SupabaseProjectRow } from "../model"
import { advisorFindings, projectViews } from "./derive"
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

const project = (ref: string, name: string, metricsEnabled: boolean, lifecycle = "ACTIVE_HEALTHY") => ({
	ref,
	name,
	region: "eu-central-1",
	status: lifecycle,
	metricsEnabled,
	logDrainEnabled: false,
	logDrainError: null,
	logDrainSourceId: null,
	logDrains: [],
	logDrainsCheckedAt: null,
	logsEnabled: metricsEnabled,
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
					project("sandboxaaaaaaaaaaaaa", "sandbox", false, "INACTIVE"),
				]
			: [],
	})

const row = (projectRef: string, overrides: Partial<SupabaseProjectRow> = {}): SupabaseProjectRow => ({
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
	maxConnections: 60,
	requests: 1_000,
	requestsPerMinute: 2.8,
	errors5xx: 4,
	issueCount: 12,
	lastSeen: "2026-10-01 12:00:00",
	...overrides,
})

const lint = (level: "ERROR" | "WARN", title: string) => ({
	advisor: "security",
	name: title,
	title,
	level,
	categories: ["SECURITY"],
	description: "",
	detail: "",
	remediation: "",
	schema: null,
	object: null,
	objectType: null,
	cacheKey: title,
})

const insights = (projectRef: string) =>
	Schema.decodeUnknownSync(SupabaseProjectInsights)({
		projectRef,
		advisors: { error: [lint("ERROR", "RLS disabled in public")], warn: [], info: [] },
		advisorsCheckedAt: NOW,
		advisorsError: null,
		topQueries: [],
		queriesCheckedAt: null,
		queriesError: null,
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
	test("a connected organization without projects shows the empty state, not a fleet verdict", () => {
		const entered = init({ search: {} }, context).model
		const windowed = steps(entered, [
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		])
		const empty = Schema.decodeUnknownSync(SupabaseIntegrationStatus)({
			...status(true),
			projects: [],
		})
		const loaded = steps(windowed, [
			Message.CompletedLoadStatus({ key: windowed.status.key ?? "", result: Result.succeed(empty) }),
			Message.CompletedFetchProjects({ key: windowed.projects.key ?? "", result: Result.succeed([]) }),
		])
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			expectView(text("No Supabase projects yet")).toExist(),
			expectView(text("Every project is healthy")).toBeAbsent(),
		)
	})

	test("not connected is the connect on-ramp and reads no advisors", () => {
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
			expectView(role("table", { name: "Supabase projects" })).toBeAbsent(),
		)
	})

	test("the window's metrics and log issues load beside the status, advisors once it is connected", () => {
		const entered = init({ search: {} }, context)
		expect(names(entered.commands)).toContain("LoadInfraSupabaseStatus")
		const windowed = pageUpdate(
			entered.model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		)
		// The status has not answered yet.
		expect(names(windowed.commands)).toContain("FetchSupabaseProjects")
		expect(names(windowed.commands)).toContain("FetchSupabaseFleetIssues")
		expect(names(windowed.commands)).not.toContain("FetchSupabaseFleetInsights")
		const answered = pageUpdate(
			windowed.model,
			Message.CompletedLoadStatus({
				key: windowed.model.status.key ?? "",
				result: Result.succeed(status(true)),
			}),
		)
		expect(names(answered.commands)).toContain("FetchSupabaseFleetInsights")
		expect(names(answered.commands)).not.toContain("FetchSupabaseProjects")
	})

	test("each project reads healthy, degraded near its connection limit, or paused", () => {
		const model = withStatus(true)
		const loaded = steps(model, [
			Message.CompletedFetchProjects({
				key: model.projects.key ?? "",
				result: Result.succeed([
					row("storefrontaaaaaaaaaa"),
					row("newprojectaaaaaaaaaa", { connectionsMax: 58 }),
				]),
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			expectView(text("1 of 3")).toExist(),
			expectView(text("new-project near its connection limit and 1 more")).toExist(),
			expectView(text("58 / 60")).toExist(),
			expectView(text("Healthy")).toExist(),
			expectView(text("Degraded")).toExist(),
			expectView(text("Paused")).toExist(),
			expectView(text("Off")).toExist(),
		)
	})

	test("the bottom row lists recurring errors across projects and the advisors' findings", () => {
		const model = withStatus(true)
		const loaded = steps(model, [
			Message.CompletedFetchProjects({ key: model.projects.key ?? "", result: Result.succeed([]) }),
			Message.CompletedFetchIssues({
				key: model.issues.key ?? "",
				result: Result.succeed(
					Schema.decodeUnknownSync(SupabaseLogIssuesResponse)({
						issues: [
							{
								projectRef: "storefrontaaaaaaaaaa",
								source: "postgres_logs",
								message: "deadlock detected",
								count: 14,
								lastSeen: "2026-10-01T09:41:00Z",
								maxSeverity: 17,
							},
						],
					}),
				),
			}),
			Message.CompletedFetchInsights({
				key: model.insights.key ?? "",
				insights: {
					insights: [insights("storefrontaaaaaaaaaa")],
					failedRefs: ["newprojectaaaaaaaaaa"],
				},
			}),
		])
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			expectView(text("deadlock detected")).toExist(),
			expectView(text("14×")).toExist(),
			expectView(text("RLS disabled in public")).toExist(),
			expectView(text("Advisors could not be read for 1 project.")).toExist(),
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

describe("advisorFindings", () => {
	test("puts every project's errors before warnings and names each finding's project", () => {
		const warned = Schema.decodeUnknownSync(SupabaseProjectInsights)({
			...Schema.encodeSync(SupabaseProjectInsights)(insights("newprojectaaaaaaaaaa")),
			advisors: { error: [], warn: [lint("WARN", "Function search_path is mutable")], info: [] },
		})
		const findings = advisorFindings(
			{ insights: [warned, insights("storefrontaaaaaaaaaa")], failedRefs: [] },
			new Map([["storefrontaaaaaaaaaa", "storefront"]]),
		)
		expect(findings.map((finding) => [finding.lint.title, finding.projectName])).toEqual([
			["RLS disabled in public", "storefront"],
			["Function search_path is mutable", "newprojectaaaaaaaaaa"],
		])
	})
})
