import { OrgId } from "@maple/domain"
import {
	encodePublicId,
	PublicIdPrefixes,
	V2AwsConnection,
	V2GcpIntegration,
	V2Source,
	V2SourceUsage,
} from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import {
	all,
	expect as expectView,
	expectAll,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ResolveThemeColors, ThemeMessage } from "../../../charts/theme-colors"
import { toLoadFailure } from "../../../data/load-failure"
import { AppRoute } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import { type PageContext, PageOutMessage } from "../../contract"
import { AwsConnectionId, GcpConnectorId, ScrapeTargetId } from "@maple/domain/primitives"
import { Message as IntegrationMessage } from "../../integrations/message"
import { Message } from "./message"
import type { Model } from "./model"
import { init, isSettingsDirty, routeChanged, sourceOf, update } from "./update"
import { breadcrumbsOf, view as pageView } from "./view"
import { focusIdOf } from "../kit/shared"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_parity"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const NOW = Date.UTC(2026, 9, 1, 12)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const resolveTheme = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))

const UUID = "0199a0e1-0000-7000-8000-000000000002"
const PUBLIC_ID = encodePublicId(PublicIdPrefixes.source, UUID)

const source = (fields: Readonly<Record<string, unknown>> = {}) =>
	Schema.decodeUnknownSync(V2Source)({
		id: PUBLIC_ID,
		object: "source",
		name: "Checkout API",
		description: null,
		platform: "nodejs",
		kind: "token",
		is_default: false,
		key_prefix: "maple_src_Q7xZa",
		integration_id: null,
		status: "active",
		allowed_signals: ["traces", "logs"],
		rate_limit_rps: 200,
		resource_attributes: [],
		expires_at: null,
		paused_at: null,
		paused_until: null,
		last_used_at: null,
		rolled_at: null,
		created_at: "2026-09-01T12:00:00.000Z",
		updated_at: "2026-09-01T12:00:00.000Z",
		health: {
			status: "healthy",
			last_data_at: "2026-10-01T11:56:00.000Z",
			problem: null,
			resources: null,
		},
		...fields,
	})

const route = (tab?: "setup" | "connection" | "settings", sourceId = PUBLIC_ID) =>
	AppRoute.Source({ sourceId, search: tab === undefined ? {} : { tab } })

const loaded = (row: V2Source, tab?: "setup" | "connection" | "settings"): Model => {
	const entered = init(route(tab), context).model
	return [
		Message.ReadClock({ nowMs: NOW }),
		Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed([row]) }),
	].reduce((model, message) => pageUpdate(model, message).model, entered)
}

describe("source detail", () => {
	test("an id that does not decode is not found without reading the list", () => {
		const entered = init(route(undefined, "nope"), context)
		expect(names(entered.commands)).toEqual(expect.arrayContaining(["ReadSourceClock"]))
		expect(names(entered.commands)).not.toContain("FetchSourceDetailList")
		expect(breadcrumbsOf(entered.model).map((crumb) => crumb.label)).toEqual(["Sources", "Not found"])
		scene(
			{ update: pageUpdate, view },
			given(entered.model),
			resolveTheme,
			expectView(text("Source not found")).toExist(),
		)
	})

	test("the overview reads the usage once the list has the source", () => {
		const entered = init(route(), context).model
		const step = pageUpdate(
			pageUpdate(entered, Message.ReadClock({ nowMs: NOW })).model,
			Message.CompletedFetchList({ key: entered.list.key ?? "", result: Result.succeed([source()]) }),
		)
		expect(names(step.commands)).toEqual(["FetchSourceUsage"])
		expect(breadcrumbsOf(step.model).map((crumb) => crumb.label)).toEqual(["Sources", "Checkout API"])
		scene(
			{ update: pageUpdate, view },
			given(step.model),
			resolveTheme,
			expectView(role("button", { name: "Roll token" })).toExist(),
			expectView(text("Volume, last 24 hours")).toExist(),
			expectView(role("tab", { name: "Setup" })).toExist(),
		)
	})

	test("another tab skips the usage until the overview shows", () => {
		const onSetup = loaded(source(), "setup")
		expect(onSetup.usage.key).toBeNull()
		expect(names(routeChanged(onSetup, route(), context).commands)).toEqual(["FetchSourceUsage"])
	})

	test("a push source the gateway refuses shows Failing and why", () => {
		const refused = source({
			health: {
				status: "failing",
				last_data_at: "2026-10-01T11:56:00.000Z",
				problem: "Rate limited at 200 requests per second",
				resources: null,
			},
		})
		scene(
			{ update: pageUpdate, view },
			given(loaded(refused)),
			resolveTheme,
			expectView(text("Rate limited at 200 requests per second")).toExist(),
			expectView(role("alert")).toExist(),
		)
	})

	test("the default source has no token actions", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(source({ kind: "default", is_default: true, key_prefix: null, name: "Default" }))),
			resolveTheme,
			expectView(role("button", { name: "Roll token" })).not.toExist(),
		)
	})

	test("a pause refreshes the list and toasts; a failure toasts the error", () => {
		const busy: Model["busy"] = "pause"
		const model: Model = { ...loaded(source()), busy }
		const done = pageUpdate(
			model,
			Message.CompletedPause({ result: Result.succeed(source({ status: "paused" })) }),
		)
		expect(names(done.commands)).toEqual(["FetchSourceDetailList"])
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Source paused. Takes effect within a minute.",
				description: "",
			}),
		)
		const failed = pageUpdate(
			model,
			Message.CompletedPause({ result: Result.fail(toLoadFailure(new Error("boom"))) }),
		)
		expect(failed.model.busy).toBeNull()
		expect(failed.outMessage?._tag === "RequestedToast" && failed.outMessage.title).toBe(
			"Couldn't pause source",
		)
	})

	test("a quick pause then resume ends resumed even when the pause's re-read lands last", () => {
		const paused = pageUpdate(
			{ ...loaded(source()), busy: "pause" },
			Message.CompletedPause({ result: Result.succeed(source({ status: "paused" })) }),
		).model
		const resumed = pageUpdate(
			{ ...paused, busy: "resume" },
			Message.CompletedResume({ result: Result.succeed(source()) }),
		)
		expect(names(resumed.commands)).toEqual(["FetchSourceDetailList"])
		const final = [
			Message.CompletedFetchList({
				key: resumed.model.list.key ?? "",
				result: Result.succeed([source()]),
			}),
			Message.CompletedFetchList({
				key: paused.list.key ?? "",
				result: Result.succeed([source({ status: "paused" })]),
			}),
		].reduce((model, message) => pageUpdate(model, message).model, resumed.model)
		expect(Option.map(sourceOf(final), (row) => row.status)).toEqual(Option.some("active"))
	})

	test("a confirmed roll shows the new token above the tab", () => {
		const confirmed = pageUpdate(loaded(source()), Message.ConfirmedRoll())
		expect(names(confirmed.commands)).toEqual(["RollSourceToken"])
		const rolled = pageUpdate(
			confirmed.model,
			Message.CompletedRoll({ result: Result.succeed({ ...source(), secret: "maple_src_secret" }) }),
		)
		expect(names(rolled.commands)).toContain("FetchSourceDetailList")
		scene(
			{ update: pageUpdate, view },
			given(rolled.model),
			resolveTheme,
			expectView(text(/^Token rolled\./)).toExist(),
		)
	})

	test("a deleted source navigates back to the list with a toast", () => {
		const confirmed = pageUpdate(loaded(source()), Message.ConfirmedDelete())
		const deleted = pageUpdate(
			confirmed.model,
			Message.CompletedDelete({ result: Result.succeed(undefined) }),
		)
		expect(deleted.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/sources",
				isReplace: false,
				toast: { type: "success", title: "Source deleted", description: "" },
			}),
		)
	})
})

describe("source detail tabs", () => {
	test("settings saves the rules for a token source and refreshes on success", () => {
		const model = loaded(source(), "settings")
		expect(model.settings?.name).toBe("Checkout API")
		const saving = pageUpdate(model, Message.SubmittedSettings())
		expect(names(saving.commands)).toEqual(["SaveSource"])
		const saved = pageUpdate(saving.model, Message.CompletedSave({ result: Result.succeed(source()) }))
		expect(names(saved.commands)).toEqual(["FetchSourceDetailList"])
		expect(saved.model.settings?.isSaving).toBe(false)
	})

	test("a successful save leaves the form clean before the list reload lands", () => {
		const edited = pageUpdate(
			loaded(source(), "settings"),
			Message.ChangedSettingsName({ value: "Renamed" }),
		).model
		expect(edited.settings !== null && isSettingsDirty(edited.settings)).toBe(true)
		const saving = pageUpdate(edited, Message.SubmittedSettings()).model
		const saved = pageUpdate(
			saving,
			Message.CompletedSave({
				result: Result.succeed(source({ name: "Renamed", updated_at: "2026-10-01T12:00:00.000Z" })),
			}),
		).model
		expect(saved.settings?.name).toBe("Renamed")
		expect(saved.settings !== null && isSettingsDirty(saved.settings)).toBe(false)
	})

	test("an empty name blocks the save", () => {
		const model = pageUpdate(
			loaded(source(), "settings"),
			Message.ChangedSettingsName({ value: "  " }),
		).model
		expect(pageUpdate(model, Message.SubmittedSettings()).commands ?? []).toEqual([])
	})

	test("leaving and reopening settings drops the unsaved edit", () => {
		const edited = pageUpdate(
			loaded(source(), "settings"),
			Message.ChangedSettingsName({ value: "Renamed" }),
		).model
		const away = routeChanged(edited, route(), context).model
		expect(away.settings).toBeNull()
		expect(routeChanged(away, route("settings"), context).model.settings?.name).toBe("Checkout API")
	})
})

describe("integration sources", () => {
	const prometheus = (fields: Readonly<Record<string, unknown>> = {}) =>
		source({
			name: "node-exporter",
			platform: "prometheus",
			kind: "integration",
			key_prefix: null,
			integration_id: null,
			health: {
				status: "stale",
				last_data_at: "2026-09-30T12:00:00.000Z",
				problem: "No scrape in 10 minutes",
				resources: null,
			},
			...fields,
		})

	test("a Prometheus source opens its own target and reads that target's checks", () => {
		const target = encodePublicId(PublicIdPrefixes.scrapeTarget, "0199a0e1-0000-7000-8000-0000000000aa")
		const entered = init(route("connection"), context).model
		const step = pageUpdate(
			pageUpdate(entered, Message.ReadClock({ nowMs: NOW })).model,
			Message.CompletedFetchList({
				key: entered.list.key ?? "",
				result: Result.succeed([prometheus({ integration_id: target })]),
			}),
		)
		expect(step.model.connection?.prometheusCard.selectedId).toBe("0199a0e1-0000-7000-8000-0000000000aa")
		expect(names(step.commands)).toContain("FetchScrapeTargetChecks")
		// Off the Connection tab the target is let go, so its checks stop polling.
		const away = routeChanged(step.model, route(), context).model
		expect(away.connection?.prometheusCard.selectedId).toBeNull()
		expect(
			routeChanged(away, route("connection"), context).model.connection?.prometheusCard.selectedId,
		).toBe("0199a0e1-0000-7000-8000-0000000000aa")
	})

	test("deleting the source's own target leaves for the list; another write re-reads it", () => {
		const uuid = "0199a0e1-0000-7000-8000-0000000000aa"
		const target = encodePublicId(PublicIdPrefixes.scrapeTarget, uuid)
		const model = loaded(prometheus({ integration_id: target }), "connection")
		const deleted = pageUpdate(
			model,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedTargetDelete({
					id: Schema.decodeSync(ScrapeTargetId)(uuid),
					failure: null,
				}),
			}),
		)
		expect(deleted.outMessage?._tag === "RequestedNavigation" && deleted.outMessage.url).toBe("/sources")
		const toggled = pageUpdate(
			model,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedToggle({
					id: Schema.decodeSync(ScrapeTargetId)(uuid),
					failure: null,
				}),
			}),
		)
		expect(names(toggled.commands)).toContain("FetchSourceDetailList")
	})

	test("the list answer builds the integration and reads its statuses", () => {
		const entered = init(route(), context).model
		const step = pageUpdate(
			pageUpdate(entered, Message.ReadClock({ nowMs: NOW })).model,
			Message.CompletedFetchList({
				key: entered.list.key ?? "",
				result: Result.succeed([prometheus()]),
			}),
		)
		expect(step.model.connection).not.toBeNull()
		expect(names(step.commands)).toEqual(
			expect.arrayContaining(["FetchSourceUsage", "LoadIntegrationsScrapeTargets"]),
		)
	})

	test("Connection replaces Setup, and the overview says when it last synced", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(prometheus())),
			resolveTheme,
			expectView(role("tab", { name: "Connection" })).toExist(),
			expectView(role("tab", { name: "Setup" })).not.toExist(),
			expectView(text("Last sync")).toExist(),
		)
	})

	test("an integration source pauses from its header and says collection keeps running", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(prometheus())),
			resolveTheme,
			expectView(role("button", { name: "Pause" })).toExist(),
			expectView(role("button", { name: "Roll token" })).not.toExist(),
		)
		const paused = prometheus({
			status: "paused",
			paused_at: "2026-10-01T11:00:00.000Z",
			health: {
				status: "paused",
				last_data_at: null,
				problem: "Data is dropped while paused",
				resources: null,
			},
		})
		scene(
			{ update: pageUpdate, view },
			given(loaded(paused)),
			resolveTheme,
			expectView(role("button", { name: "Resume" })).toExist(),
			expectView(text(/^Maple keeps collecting/)).toExist(),
		)
		expect(names(pageUpdate(loaded(paused), Message.ClickedResume()).commands)).toEqual(["ResumeSource"])
	})

	test("Delete lists what it disconnects, deletes through the sources API and offers a pause instead", () => {
		const opened = pageUpdate(loaded(prometheus()), Message.ClickedDelete()).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			resolveTheme,
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(text("Maple stops scraping its targets and removes them")).toExist(),
			expectView(role("button", { name: "Disconnect and delete" })).toExist(),
			expectView(role("button", { name: "Pause instead" })).toExist(),
		)
		expect(names(pageUpdate(opened, Message.ConfirmedDelete()).commands)).toEqual(["DeleteSource"])
		const pausing = pageUpdate(opened, Message.ClickedPauseUntilResumed())
		expect(pausing.model.busy).toBe("pause")
		expect(pausing.model.deleteDialog.isOpen).toBe(false)
		expect(names(pausing.commands)).toContain("PauseSource")
	})

	describe("a Google Cloud source's Delete", () => {
		const connectorUuid = "0199a0e1-0000-7000-8000-0000000000bb"
		const connectorId = encodePublicId(PublicIdPrefixes.gcpConnector, connectorUuid)
		const gcp = (integrationId: string | null) =>
			prometheus({ name: "Google Cloud acme-prod", platform: "gcp", integration_id: integrationId })
		const gcpStatus = Schema.decodeUnknownSync(V2GcpIntegration)({
			object: "gcp_integration",
			metrics_available: true,
			connectors: [
				{
					id: connectorId,
					object: "gcp_connector",
					scope_type: "project",
					scope_id: "acme-prod",
					project_id: "acme-prod",
					logs_enabled: true,
					metrics_enabled: true,
					created_at: "2026-09-01T00:00:00.000Z",
					last_log_received_at: null,
					last_log_error: null,
					applied_logs_enabled: true,
					applied_metrics_enabled: true,
					setup_reported_at: "2026-09-01T00:05:00.000Z",
					last_metrics_received_at: null,
					last_metrics_error: null,
					discovered_project_count: 1,
					last_resources_error: null,
				},
			],
		})
		const withStatus = (model: Model): Model =>
			pageUpdate(
				model,
				Message.GotConnectionMessage({
					message: IntegrationMessage.CompletedLoadGcp({
						key: model.connection?.statuses.gcp.key ?? "",
						result: Result.succeed(gcpStatus),
					}),
				}),
			).model

		test("opens the integration's removal dialog, which reads the cleanup script", () => {
			const clicked = pageUpdate(withStatus(loaded(gcp(connectorId))), Message.ClickedDelete())
			expect(clicked.model.deleteDialog.isOpen).toBe(false)
			expect(clicked.model.connection?.gcpCard.disconnectDialog.isOpen).toBe(true)
			expect(names(clicked.commands)).toContain("LoadGcpSetupScripts")
		})

		test("says so while the connection has not loaded, instead of doing nothing", () => {
			const clicked = pageUpdate(loaded(gcp(connectorId)), Message.ClickedDelete())
			expect(clicked.outMessage?._tag === "RequestedToast" && clicked.outMessage.type).toBe("error")
		})

		test("deletes a source whose connector is gone through the generic dialog", () => {
			const clicked = pageUpdate(loaded(gcp(null)), Message.ClickedDelete())
			expect(clicked.model.deleteDialog.isOpen).toBe(true)
			expect(names(pageUpdate(clicked.model, Message.ConfirmedDelete()).commands)).toEqual([
				"DeleteSource",
			])
		})

		test("once removed, leaves for the integration page that keeps the cleanup script", () => {
			const done = pageUpdate(
				withStatus(loaded(gcp(connectorId))),
				Message.GotConnectionMessage({
					message: IntegrationMessage.CompletedGcpDisconnect({
						id: Schema.decodeSync(GcpConnectorId)(connectorUuid),
						cleanupScript: "gcloud ...",
						failure: null,
					}),
				}),
			)
			expect(done.outMessage?._tag === "RequestedNavigation" && done.outMessage.url).toBe(
				"/sources/new?integration=gcp",
			)
		})
	})

	test("disconnecting the integration from its Connection tab leaves for the list", () => {
		const left = pageUpdate(
			loaded(prometheus({ platform: "railway", name: "Railway" }), "connection"),
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedDisconnect({ integration: "railway", failure: null }),
			}),
		)
		expect(left.outMessage?._tag === "RequestedNavigation" && left.outMessage.url).toBe("/sources")
	})

	test("a multi-account Cloudflare disconnect leaves for the list too", () => {
		const left = pageUpdate(
			loaded(prometheus({ platform: "cloudflare", name: "Cloudflare" }), "connection"),
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedDisconnect({
					integration: "cloudflare-multi",
					failure: null,
				}),
			}),
		)
		expect(left.outMessage?._tag === "RequestedNavigation" && left.outMessage.url).toBe("/sources")
	})

	test("a GitHub delete says its repositories and commits go with it", () => {
		const opened = pageUpdate(
			loaded(prometheus({ platform: "github", name: "GitHub acme" })),
			Message.ClickedDelete(),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			resolveTheme,
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(
				text("Maple deletes this installation's repositories, branches and commits"),
			).toExist(),
			expectView(text("Data already stored stays until retention ends")).not.toExist(),
		)
	})

	test("an integration's settings pause and delete it, with no rules to set", () => {
		const model = loaded(prometheus(), "settings")
		scene(
			{ update: pageUpdate, view },
			given(model),
			resolveTheme,
			expectView(text("Ingestion")).toExist(),
			expectView(role("button", { name: "Delete source" })).toExist(),
			expectView(text("Rate limit")).not.toExist(),
		)
		expect(names(pageUpdate(model, Message.ClickedPauseUntilResumed()).commands)).toContain("PauseSource")
	})

	test("the default source's settings point to a new source for rules", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(
					source({ kind: "default", is_default: true, key_prefix: null, name: "Default" }),
					"settings",
				),
			),
			resolveTheme,
			expectView(role("link", { name: "Create a source" })).toExist(),
			expectView(text("Rate limit")).not.toExist(),
			expectView(role("button", { name: "Delete source" })).not.toExist(),
		)
	})

	test("the overview totals every signal and its stored size", () => {
		const model = loaded(prometheus())
		const withUsage = pageUpdate(
			model,
			Message.CompletedFetchUsage({
				key: model.usage.key ?? "",
				result: Result.succeed(
					Schema.decodeUnknownSync(V2SourceUsage)({
						object: "source_usage",
						window_start: "2026-09-30T13:00:00.000Z",
						window_end: "2026-10-01T12:00:00.000Z",
						buckets: [
							{
								hour: "2026-10-01T10:00:00.000Z",
								spans: 0,
								logs: 0,
								metrics: 1500,
								bytes: 225_000,
							},
							{
								hour: "2026-10-01T11:00:00.000Z",
								spans: 0,
								logs: 0,
								metrics: 500,
								bytes: 75_000,
							},
						],
					}),
				),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(withUsage),
			resolveTheme,
			expectView(text("300 KB")).toExist(),
			expectView(text("2K metric points")).toExist(),
		)
	})

	test("a Setup link opens Connection on an integration source, and the reverse on a push source", () => {
		expect(loaded(prometheus(), "setup").tab).toBe("connection")
		expect(loaded(source(), "connection").tab).toBe("setup")
		expect(loaded(source()).connection).toBeNull()
	})
})

const awsConnection = (id: AwsConnectionId): V2AwsConnection =>
	Schema.decodeUnknownSync(V2AwsConnection)({
		id: encodePublicId(PublicIdPrefixes.awsConnection, id),
		object: "aws_connection",
		account_id: "123456789012",
		role_arn: "arn:aws:iam::123456789012:role/MapleIntegration-018f2b3c4d5e4f708192a3b4",
		oidc_issuer: "https://api.maple.dev/oidc/aws",
		oidc_subject: "aws-connection:018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
		modules: [],
		granted_modules: null,
		template_version: null,
		setup_outdated: false,
		verified_at: null,
		last_checked_at: "2026-10-01T11:59:00.000Z",
		last_check_error: "Maple cannot assume the role yet.",
		metric_stream: null,
		metric_stream_changed_at: null,
		metrics_last_received_at: null,
		metrics_last_error: null,
		created_at: "2026-10-01T11:00:00.000Z",
	})

describe("integration focus", () => {
	test("an AWS source's card shows only the connection it stands for", () => {
		const connection = "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
		const aws = source({
			platform: "aws",
			kind: "integration",
			key_prefix: null,
			integration_id: encodePublicId(PublicIdPrefixes.awsConnection, connection),
		})
		expect(focusIdOf(aws)).toBe(connection)
	})

	test("an AWS check in the Connection tab re-reads the source, so the header shows its health", () => {
		const connection = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const model = loaded(
			source({
				platform: "aws",
				kind: "integration",
				key_prefix: null,
				integration_id: encodePublicId(PublicIdPrefixes.awsConnection, connection),
			}),
			"connection",
		)
		const checked = pageUpdate(
			model,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedAwsCheck({
					id: connection,
					quiet: false,
					connection: awsConnection(connection),
					failure: null,
				}),
			}),
		)
		expect(names(checked.commands)).toContain("FetchSourceDetailList")
		expect(names(checked.commands)).toContain("ReadSourceClock")
		// A background poll that still finds no stack changes nothing the header shows.
		const polled = pageUpdate(
			model,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedAwsCheck({
					id: connection,
					quiet: true,
					connection: awsConnection(connection),
					failure: null,
				}),
			}),
		)
		expect(names(polled.commands)).not.toContain("FetchSourceDetailList")
		// A click while a poll is in flight makes it the user's: its answer re-reads the header.
		const withStatus = pageUpdate(
			model,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedLoadAws({
					key: model.connection?.statuses.aws.key ?? "",
					result: Result.succeed({
						object: "aws_integration",
						available: true,
						modules: [],
						connections: [awsConnection(connection)],
					}),
				}),
			}),
		).model
		const polling = pageUpdate(
			withStatus,
			Message.GotConnectionMessage({ message: IntegrationMessage.TickedAwsPending() }),
		)
		expect(names(polling.commands)).toContain("CheckAwsConnection")
		const clicking = pageUpdate(
			polling.model,
			Message.GotConnectionMessage({ message: IntegrationMessage.ClickedAwsCheck({ id: connection }) }),
		)
		// The poll in flight answers for the click: no second call to AWS.
		expect(names(clicking.commands)).not.toContain("CheckAwsConnection")
		const clicked = clicking.model
		const answered = pageUpdate(
			clicked,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedAwsCheck({
					id: connection,
					quiet: true,
					connection: awsConnection(connection),
					failure: null,
				}),
			}),
		)
		expect(names(answered.commands)).toContain("FetchSourceDetailList")
	})

	test("an AWS source's Delete opens the AWS disconnect dialog, which keeps the cleanup script", () => {
		const connection = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const model = loaded(
			source({
				platform: "aws",
				kind: "integration",
				key_prefix: null,
				integration_id: encodePublicId(PublicIdPrefixes.awsConnection, connection),
			}),
			"connection",
		)
		// Before the status loads there is no connection to disconnect yet.
		const early = pageUpdate(model, Message.ClickedDelete())
		expect(early.outMessage?._tag === "RequestedToast" && early.outMessage.type).toBe("error")
		const withStatus = pageUpdate(
			model,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedLoadAws({
					key: model.connection?.statuses.aws.key ?? "",
					result: Result.succeed({
						object: "aws_integration",
						available: true,
						modules: [],
						connections: [awsConnection(connection)],
					}),
				}),
			}),
		).model
		const clicked = pageUpdate(withStatus, Message.ClickedDelete())
		expect(clicked.model.deleteDialog.isOpen).toBe(false)
		expect(clicked.model.connection?.awsCard.disconnectDialog.isOpen).toBe(true)
	})

	test("an AWS source's Delete shows the disconnect dialog from the Overview tab too", () => {
		const connection = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const model = loaded(
			source({
				platform: "aws",
				kind: "integration",
				key_prefix: null,
				integration_id: encodePublicId(PublicIdPrefixes.awsConnection, connection),
			}),
		)
		const withStatus = pageUpdate(
			model,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedLoadAws({
					key: model.connection?.statuses.aws.key ?? "",
					result: Result.succeed({
						object: "aws_integration",
						available: true,
						modules: [],
						connections: [awsConnection(connection)],
					}),
				}),
			}),
		).model
		const name = "Disconnect AWS account 123456789012?"
		const mountDialog = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(withStatus, Message.ClickedDelete()).model),
			resolveTheme,
			mountDialog,
			expectView(role("alertdialog", { name })).toExist(),
		)
		// The Connection tab mounts it once, not once per card and header.
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate({ ...withStatus, tab: "connection" }, Message.ClickedDelete()).model),
			resolveTheme,
			mountDialog,
			expectAll(all.role("alertdialog", { name })).toHaveCount(1),
		)
	})

	test("disconnecting its own AWS connection leaves for the AWS page, where the cleanup waits", () => {
		const connection = Schema.decodeSync(AwsConnectionId)("018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const model = loaded(
			source({
				platform: "aws",
				kind: "integration",
				key_prefix: null,
				integration_id: encodePublicId(PublicIdPrefixes.awsConnection, connection),
			}),
			"connection",
		)
		const removed = { connectionId: connection, accountId: "123456789012", cleanupScript: "cleanup" }
		const done = pageUpdate(
			model,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedAwsDisconnect({ id: connection, removed, error: null }),
			}),
		)
		expect(done.outMessage?._tag === "RequestedNavigation" && done.outMessage.url).toBe(
			"/sources/new?integration=aws",
		)
		expect(names(done.commands)).toContain("WriteAwsRemovedStacks")
		// Another account's disconnect leaves this source where it is.
		const other = Schema.decodeSync(AwsConnectionId)("028f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8")
		const elsewhere = pageUpdate(
			model,
			Message.GotConnectionMessage({
				message: IntegrationMessage.CompletedAwsDisconnect({
					id: other,
					removed: { ...removed, connectionId: other },
					error: null,
				}),
			}),
		)
		expect(elsewhere.outMessage?._tag).not.toBe("RequestedNavigation")
	})
})
