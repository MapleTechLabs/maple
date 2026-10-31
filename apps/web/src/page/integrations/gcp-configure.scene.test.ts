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

const SETUP_FIELDS = {
	push_endpoint: "https://ingest.maple.dev/v1/logpush/gcp/x",
	log_filter: "severity>=DEFAULT",
	maple_service_account_email: "collector@maple-prod.iam.gserviceaccount.com",
	terraform: "# maple.tf",
	alchemy: "// maple.ts",
}

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

const created = () =>
	Schema.decodeUnknownSync(V2GcpConnector)(
		connector({
			id: createdId,
			applied_logs_enabled: null,
			applied_metrics_enabled: null,
			setup_reported_at: null,
		}),
	)

describe("google cloud connect flow: a new connection", () => {
	test("another kind of scope starts the ID over and keeps the host project", () => {
		const typedIn = run(loaded([connector()]), [
			...typed("scopeId", "acme-prod"),
			...typed("hostProjectId", "acme-observability"),
		])
		expect(configureOf(typedIn).target).toEqual({ _tag: "New" })
		const folder = run(typedIn, [
			Message.GotGcpScopeTypeMessage({
				message: ToggleGroup.Message.ClickedItem({ value: "folder", index: 1 }),
			}),
		])
		expect(configureOf(folder).scopeType).toBe("folder")
		expect(configureOf(folder).scopeId.value).toBe("")
		expect(configureOf(folder).hostProjectId.value).toBe("acme-observability")
	})

	test("an invalid ID sends no create", () => {
		const model = run(loaded([]), typed("scopeId", "Acme_Prod"))
		expect(names(step(model, Message.SubmittedGcpCreate()).commands)).toEqual([])
	})

	test("the create sends once, then reads the setup for Go live with the chosen method", () => {
		const scoped = run(loaded([]), [
			...typed("scopeId", "acme-prod"),
			Message.ClickedGcpMethod({ method: "terraform" }),
		])
		const sent = step(scoped, Message.SubmittedGcpCreate())
		expect(names(sent.commands)).toEqual(["CreateGcpConnector"])
		expect(names(step(sent.model, Message.SubmittedGcpCreate()).commands)).toEqual([])
		const done = step(
			sent.model,
			Message.CompletedGcpCreate({ opens: 0, connector: created(), failure: null }),
		)
		expect(configureOf(done.model).target).toEqual({
			_tag: "Connection",
			id: created().id,
			stage: "apply",
		})
		expect(configureOf(done.model).opened?.rerun).toBe(false)
		expect(configureOf(done.model).method).toBe("terraform")
		expect(names(done.commands)).toEqual(
			expect.arrayContaining(["LoadGcpConfigureScripts", "LoadIntegrationsGcpStatus"]),
		)
	})

	test("a filter changed after the create asks for its script again", () => {
		const done = run(loaded([]), [
			...typed("scopeId", "acme-prod"),
			Message.SubmittedGcpCreate(),
			Message.CompletedGcpCreate({ opens: 0, connector: created(), failure: null }),
		])
		const opened = step(done, Message.ClickedGcpForwardOutput())
		// Opening the runtime ticks keeps the same filter, so the same script.
		expect(names(opened.commands)).toEqual([])
		const ticked = step(opened.model, Message.ToggledGcpRuntime({ runtime: "cloud_run" }))
		expect(names(ticked.commands)).toEqual(["LoadGcpConfigureScripts"])
	})

	test("a refused create keeps its message until the next edit", () => {
		const failed = run(loaded([]), [
			...typed("scopeId", "acme-prod"),
			Message.SubmittedGcpCreate(),
			Message.CompletedGcpCreate({ opens: 0, connector: null, failure: toLoadFailure("nope") }),
		])
		expect(configureOf(failed).isCreating).toBe(false)
		expect(configureOf(failed).createError).not.toBeNull()
		expect(configureOf(run(failed, typed("scopeId", "acme-prod-2"))).createError).toBeNull()
	})

	test("a deployment without metrics turns the new connection's metrics off", () => {
		const start = init({ search: { integration: "gcp" } }, context).model
		expect(configureOf(start).newFlags.metrics_enabled).toBe(true)
		const unavailable = step(
			start,
			Message.CompletedLoadGcp({
				key: start.statuses.gcp.key ?? "",
				result: Result.succeed(
					Schema.decodeUnknownSync(V2GcpIntegration)({
						object: "gcp_integration",
						metrics_available: false,
						connectors: [],
					}),
				),
			}),
		).model
		expect(configureOf(unavailable).newFlags).toEqual({ logs_enabled: true, metrics_enabled: false })
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
	test("Configure opens the data step; unchanged, Continue and the Method step rerun with the sink's filter kept", () => {
		const model = configured()
		expect(configureOf(model).opened).toBeNull()
		const method = step(model, Message.ClickedGcpChooseApply())
		expect([configureOf(method.model).connectionStage, configureOf(method.model).rerun]).toEqual([
			"method",
			true,
		])
		const next = step(method.model, Message.ClickedGcpMethodContinue())
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
		const saved = step(sent, Message.CompletedGcpUpdate({ opens: 1, id, flags, failure: null }))
		expect(configureOf(saved.model).asked).toEqual(flags)
		expect(configureOf(saved.model).rerun).toBe(false)
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
				opens: 1,
				id,
				flags: { logs_enabled: true, metrics_enabled: false },
				failure: toLoadFailure("nope"),
			}),
		)
		expect(failed.outMessage).toEqual(
			expect.objectContaining({ _tag: "RequestedToast", title: "Couldn't save the change" }),
		)
		expect(configureOf(failed.model).confirm.isOpen).toBe(true)
		expect(configureOf(failed.model).opened).toBeNull()
	})

	test("a script answer for an earlier request is dropped", () => {
		const opened = run(configured(), [
			Message.ClickedGcpChooseApply(),
			Message.ClickedGcpMethodContinue(),
		])
		const stale = step(
			opened,
			Message.CompletedGcpConfigureScripts({
				key: "stale",
				result: Result.succeed({
					object: "gcp_connector.setup_scripts",
					setup_script: "x",
					cleanup_script: "y",
					...SETUP_FIELDS,
				}),
			}),
		)
		expect(configureOf(stale.model).scripts.data._tag).toBe("Loading")
	})
})

const toMethod = () => step(configured(), Message.ClickedGcpChooseApply()).model
const setUp = (method: "script" | "manual" | "terraform" | "alchemy") =>
	run(toMethod(), [Message.ClickedGcpMethod({ method }), Message.ClickedGcpMethodContinue()])

describe("google cloud wizard: the Method and Set up steps", () => {
	test("the code row starts on Terraform, the toggle switches to Alchemy, and Continue reads the file", () => {
		const code = run(toMethod(), [Message.ClickedGcpMethod({ method: "terraform" })])
		expect(configureOf(code).method).toBe("terraform")
		const alchemy = run(code, [
			Message.GotGcpFlavourMessage({
				message: ToggleGroup.Message.ClickedItem({ value: "alchemy", index: 1 }),
			}),
		])
		expect([configureOf(alchemy).method, configureOf(alchemy).flavourGroup.values]).toEqual([
			"alchemy",
			["alchemy"],
		])
		const next = step(alchemy, Message.ClickedGcpMethodContinue())
		expect(configureOf(next.model).opened).not.toBeNull()
		expect(names(next.commands)).toEqual(["LoadGcpConfigureScripts"])
	})

	test("Edit on the Set up step returns to the Method step with its choice; Back there, to the data step", () => {
		const back = run(setUp("manual"), [Message.ClickedGcpRunEdit()])
		expect([
			configureOf(back).opened,
			configureOf(back).connectionStage,
			configureOf(back).method,
		]).toEqual([null, "method", "manual"])
		expect(configureOf(run(back, [Message.ClickedGcpRunEdit()])).connectionStage).toBe("choose")
	})

	test("I've removed them records the removal once, then reads the status again", () => {
		const sent = step(setUp("manual"), Message.ClickedGcpConfirmRemoval())
		expect(names(sent.commands)).toEqual(["ConfirmGcpRemoval"])
		expect(names(step(sent.model, Message.ClickedGcpConfirmRemoval()).commands)).toEqual([])
		const done = step(sent.model, Message.CompletedGcpConfirmRemoval({ failure: null }))
		expect(configureOf(done.model).isConfirmingRemoval).toBe(false)
		expect(names(done.commands)).toContain("LoadIntegrationsGcpStatus")
		const failed = step(
			sent.model,
			Message.CompletedGcpConfirmRemoval({ failure: toLoadFailure("nope") }),
		)
		expect(failed.outMessage).toEqual(
			expect.objectContaining({ _tag: "RequestedToast", title: "Couldn't record the removal" }),
		)
	})

	test("copying the prompt shows it in the file's place until Back, and a new Set up step starts on the file", () => {
		const copying = step(setUp("terraform"), Message.ClickedGcpCopyPrompt({ prompt: "Add maple.tf" }))
		expect(names(copying.commands)).toEqual(["CopyGcpPrompt"])
		const refused = run(copying.model, [Message.CompletedGcpPromptCopy({ isCopied: false })])
		expect([configureOf(refused).isPromptShown, configureOf(refused).promptCopied]).toEqual([true, false])
		expect(configureOf(run(refused, [Message.ClickedGcpPromptBack()])).isPromptShown).toBe(false)
		const again = run(refused, [Message.ClickedGcpRunEdit(), Message.ClickedGcpMethodContinue()])
		expect([configureOf(again).isPromptShown, configureOf(again).promptCopied]).toEqual([false, null])
	})

	test("the console steps open one at a time; the first is open until another is clicked", () => {
		const closed = run(setUp("manual"), [
			Message.ClickedGcpManualStep({ title: "Topic", firstTitle: "Topic" }),
		])
		expect([configureOf(closed).isManualTouched, configureOf(closed).manualOpen]).toEqual([true, null])
		const sink = run(closed, [Message.ClickedGcpManualStep({ title: "Sink", firstTitle: "Topic" })])
		expect(configureOf(sink).manualOpen).toBe("Sink")
	})
})
