import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2GcpConnector, V2GcpIntegration } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import * as Field from "../../ui/field"
import * as Menu from "../../ui/menu"
import * as ToggleGroup from "../../ui/toggle-group"
import type { PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const step = (model: Model, message: Message) => update(model, message, context)
const run = (model: Model, messages: ReadonlyArray<Message>) =>
	messages.reduce((current, message) => step(current, message).model, model)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const publicId = encodePublicId(PublicIdPrefixes.gcpConnector, "00000000-0000-4000-8000-000000000402")
const createdId = encodePublicId(PublicIdPrefixes.gcpConnector, "00000000-0000-4000-8000-000000000409")

const connector = (fields: Readonly<Record<string, unknown>> = {}) => ({
	id: publicId,
	object: "gcp_connector",
	scope_type: "project",
	scope_id: "acme-shop-prod",
	project_id: "acme-shop-prod",
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
	...fields,
})

const status = (connectors: ReadonlyArray<unknown>) =>
	Schema.decodeUnknownSync(V2GcpIntegration)({
		object: "gcp_integration",
		metrics_available: true,
		connectors,
	})

const loaded = (connectors: ReadonlyArray<unknown>): Model => {
	const start = init({ search: { integration: "gcp" } }, context).model
	const key = start.statuses.gcp.key ?? ""
	return step(start, Message.CompletedLoadGcp({ key, result: Result.succeed(status(connectors)) })).model
}

const configureOf = (model: Model) => {
	const configure = model.gcpCard.configure
	if (configure === null) throw new Error("the wizard is closed")
	return configure
}

const typed = (field: "scopeId" | "hostProjectId", value: string): ReadonlyArray<Message> => [
	Message.GotGcpScopeFieldMessage({ field, message: Field.Message.ChangedValue({ value }) }),
	Message.GotGcpScopeFieldMessage({ field, message: Field.Message.BlurredControl() }),
]

const openNew = (model: Model) => run(model, [Message.ClickedGcpConfigure({ target: { _tag: "New" } })])

describe("google cloud wizard: a new connection", () => {
	test("a project ID that breaks the rule keeps the scope step", () => {
		const model = run(openNew(loaded([])), [
			...typed("scopeId", "Acme_Prod"),
			Message.SubmittedGcpScope(),
		])
		expect(configureOf(model).step).toBe("scope")
		const valid = run(model, [...typed("scopeId", "acme-prod"), Message.SubmittedGcpScope()])
		expect(configureOf(valid).step).toBe("data")
		expect(configureOf(valid).newTitle).toBe("Connect Google Cloud")
	})

	test("another kind of scope starts the ID over and keeps the host project", () => {
		const typedIn = run(openNew(loaded([connector()])), [
			...typed("scopeId", "acme-prod"),
			...typed("hostProjectId", "acme-observability"),
		])
		const folder = run(typedIn, [
			Message.GotGcpScopeTypeMessage({
				message: ToggleGroup.Message.ClickedItem({ value: "folder", index: 1 }),
			}),
		])
		expect(configureOf(folder).scopeType).toBe("folder")
		expect(configureOf(folder).scopeId.value).toBe("")
		expect(configureOf(folder).hostProjectId.value).toBe("acme-observability")
		expect(configureOf(folder).newTitle).toBe("Add connection")
	})

	test("the create sends once, then leads into the run step with its script", () => {
		const data = run(openNew(loaded([])), [...typed("scopeId", "acme-prod"), Message.SubmittedGcpScope()])
		const sent = step(data, Message.SubmittedGcpCreate())
		expect(names(sent.commands)).toEqual(["CreateGcpConnector"])
		expect(names(step(sent.model, Message.SubmittedGcpCreate()).commands)).toEqual([])
		const created = Schema.decodeUnknownSync(V2GcpConnector)(
			connector({
				id: createdId,
				applied_logs_enabled: null,
				applied_metrics_enabled: null,
				setup_reported_at: null,
			}),
		)
		const done = step(sent.model, Message.CompletedGcpCreate({ connector: created, failure: null }))
		expect(configureOf(done.model).target).toEqual({ _tag: "Connection", id: created.id, stage: "apply" })
		expect(configureOf(done.model).opened?.rerun).toBe(false)
		expect(names(done.commands)).toEqual(
			expect.arrayContaining(["LoadGcpConfigureScripts", "LoadIntegrationsGcpStatus"]),
		)
	})

	test("a refused create keeps its message until the next edit", () => {
		const data = run(openNew(loaded([])), [...typed("scopeId", "acme-prod"), Message.SubmittedGcpScope()])
		const failed = run(data, [
			Message.SubmittedGcpCreate(),
			Message.CompletedGcpCreate({ connector: null, failure: toLoadFailure("nope") }),
		])
		expect(configureOf(failed).isCreating).toBe(false)
		expect(configureOf(failed).createError).not.toBeNull()
		expect(
			configureOf(run(failed, [Message.ToggledGcpRuntime({ runtime: "cloud_run" })])).filter.runtimes,
		).toEqual(["cloud_run"])
	})

	test("Cancel, Close and Done drop the wizard", () => {
		expect(run(openNew(loaded([])), [Message.ClosedGcpConfigure()]).gcpCard.configure).toBeNull()
	})
})

const configured = () =>
	step(
		loaded([connector()]),
		Message.GotGcpMenuMessage({
			id: Schema.decodeUnknownSync(V2GcpConnector)(connector()).id,
			message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value: "configure" } }),
		}),
	).model

const metricsOff = () => run(configured(), [Message.ToggledGcpCollect({ capability: "metrics" })])

describe("google cloud wizard: a connection", () => {
	test("Configure opens the data step; unchanged, Continue reruns with the sink's filter kept", () => {
		const model = configured()
		expect(configureOf(model).opened).toBeNull()
		const next = step(model, Message.ClickedGcpChooseApply())
		expect(configureOf(next.model).opened?.rerun).toBe(true)
		expect(names(next.commands)).toEqual(["LoadGcpConfigureScripts"])
	})

	test("turning metrics off asks first, then sends only that flag, once", () => {
		const asked = step(metricsOff(), Message.ClickedGcpChooseApply())
		expect(configureOf(asked.model).confirm.isOpen).toBe(true)
		expect(names(asked.commands)).not.toContain("UpdateGcpConnector")
		const sent = step(asked.model, Message.ConfirmedGcpSave())
		expect(names(sent.commands)).toEqual(["UpdateGcpConnector"])
		expect(names(step(sent.model, Message.ConfirmedGcpSave()).commands)).toEqual([])
	})

	test("a saved change shows over the read until the status lists the connection again", () => {
		const sent = run(metricsOff(), [Message.ClickedGcpChooseApply(), Message.ConfirmedGcpSave()])
		const id = Schema.decodeUnknownSync(V2GcpConnector)(connector()).id
		const flags = { logs_enabled: true, metrics_enabled: false }
		const saved = step(sent, Message.CompletedGcpUpdate({ id, flags, failure: null }))
		expect(configureOf(saved.model).asked).toEqual(flags)
		expect(configureOf(saved.model).opened?.rerun).toBe(false)
		expect(names(saved.commands)).toEqual(expect.arrayContaining(["LoadIntegrationsGcpStatus"]))
		const key = saved.model.statuses.gcp.key ?? ""
		const read = step(
			saved.model,
			Message.CompletedLoadGcp({ key, result: Result.succeed(status([connector()])) }),
		)
		expect(configureOf(read.model).asked).toBeNull()
	})

	test("a failed save toasts and keeps the confirmation open", () => {
		const sent = run(metricsOff(), [Message.ClickedGcpChooseApply(), Message.ConfirmedGcpSave()])
		const id = Schema.decodeUnknownSync(V2GcpConnector)(connector()).id
		const failed = step(
			sent,
			Message.CompletedGcpUpdate({
				id,
				flags: { logs_enabled: true, metrics_enabled: false },
				failure: toLoadFailure("nope"),
			}),
		)
		expect(failed.outMessage).toEqual(
			expect.objectContaining({ _tag: "RequestedToast", title: "Failed to save the change" }),
		)
		expect(configureOf(failed.model).confirm.isOpen).toBe(true)
		expect(configureOf(failed.model).opened).toBeNull()
	})

	test("a script answer for an earlier request is dropped", () => {
		const opened = step(configured(), Message.ClickedGcpChooseApply()).model
		const stale = step(
			opened,
			Message.CompletedGcpConfigureScripts({
				key: "stale",
				result: Result.succeed({
					object: "gcp_connector.setup_scripts",
					setup_script: "x",
					cleanup_script: "y",
				}),
			}),
		)
		expect(configureOf(stale.model).scripts.data._tag).toBe("Loading")
	})
})
