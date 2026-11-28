import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2GcpIntegration } from "@maple/domain/http/v2"
import { Effect, Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test, vi } from "vitest"
import * as Menu from "@maple/views/ui/menu"
import { toLoadFailure } from "@maple/views/data/load-failure"
import type { PageContext } from "../../../contract"
import { GcpMessage, ReadRemoved, WriteRemoved } from "./gcp"
import { Message } from "../../../integrations/message"
import type { Model } from "../../../integrations/model"
import { init, update } from "../../../integrations/update"
import { view as pageView } from "../../../integrations/view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const gcpMsg = (message: GcpMessage) => Message.GotGcpMessage({ message })
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const publicId = encodePublicId(PublicIdPrefixes.gcpConnector, "00000000-0000-4000-8000-000000000402")

const view = withViewInputs(pageView, { context })()

const status = (
	applied: boolean | null,
	over: Readonly<Record<string, unknown>> = {},
	metricsAvailable = true,
) =>
	Schema.decodeSync(V2GcpIntegration)({
		object: "gcp_integration",
		metrics_available: metricsAvailable,
		connectors: [
			{
				id: publicId,
				object: "gcp_connector",
				scope_type: "project",
				scope_id: "acme-prod",
				project_id: "acme-prod",
				logs_enabled: true,
				metrics_enabled: true,
				security_enabled: false,
				created_at: "2026-09-01T00:00:00.000Z",
				last_log_received_at: null,
				last_log_error: null,
				applied_logs_enabled: applied,
				applied_metrics_enabled: applied,
				setup_reported_at: applied === null ? null : "2026-09-01T00:05:00.000Z",
				last_metrics_received_at: null,
				last_metrics_error: null,
				discovered_project_count: 1,
				last_resources_error: null,
				...over,
			},
		],
	})

const loaded = (
	applied: boolean | null,
	over: Readonly<Record<string, unknown>> = {},
	metricsAvailable = true,
): Model => {
	const start = init({ search: { integration: "gcp" } }, context).model
	const key = start.statuses.gcp.key ?? ""
	return pageUpdate(
		start,
		Message.CompletedLoadGcp({ key, result: Result.succeed(status(applied, over, metricsAvailable)) }),
	).model
}

const connectorId = (model: Model) => {
	const data = model.statuses.gcp.data
	return data._tag === "Success" ? data.data.connectors[0]?.id : undefined
}

const pick = (model: Model, value: string) => {
	const id = connectorId(model)
	if (id === undefined) throw new Error("no connector")
	return pageUpdate(
		model,
		gcpMsg(
			GcpMessage.GotGcpMenuMessage({
				id,
				message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value } }),
			}),
		),
	)
}

describe("google cloud card", () => {
	test("disconnecting a reported connection opens the cleanup dialog and reads its scripts", () => {
		const opened = pick(loaded(true), "disconnect")
		expect(opened.model.gcpCard.disconnectDialog.kind).toBe("dialog")
		expect(names(opened.commands)).toContain("LoadGcpSetupScripts")
	})

	test("a connection never reported confirms without reading scripts", () => {
		const opened = pick(loaded(null), "disconnect")
		expect(opened.model.gcpCard.disconnectDialog.kind).toBe("alert-dialog")
		expect(names(opened.commands)).not.toContain("LoadGcpSetupScripts")
	})

	test("a disconnect keeps the cleanup script and re-reads the status; a failure toasts", () => {
		const opened = pick(loaded(true), "disconnect").model
		const sent = pageUpdate(opened, gcpMsg(GcpMessage.ConfirmedGcpDisconnect()))
		expect(names(sent.commands)).toEqual(["DeleteGcpConnector"])
		const id = connectorId(opened)
		if (id === undefined) throw new Error("no connector")
		const done = pageUpdate(
			sent.model,
			gcpMsg(GcpMessage.CompletedGcpDisconnect({ id, cleanupScript: "echo bye", failure: null })),
		)
		expect(Arr.map(done.model.gcpCard.removed, (entry) => entry.cleanupScript)).toEqual(["echo bye"])
		expect(names(done.commands)).toEqual(
			expect.arrayContaining(["WriteGcpRemovedConnectors", "LoadIntegrationsGcpStatus"]),
		)
		const failed = pageUpdate(
			sent.model,
			gcpMsg(
				GcpMessage.CompletedGcpDisconnect({
					id,
					cleanupScript: null,
					failure: toLoadFailure("nope"),
				}),
			),
		)
		expect(failed.model.gcpCard.removed).toEqual([])
		expect(failed.outMessage).toEqual(
			expect.objectContaining({ _tag: "RequestedToast", title: "Couldn't disconnect Google Cloud" }),
		)
	})

	test("View logs navigates to the connection's forwarded logs", () => {
		const step = pick(loaded(true), "logs")
		expect(step.outMessage?._tag).toBe("RequestedNavigation")
		expect(step.outMessage?._tag === "RequestedNavigation" ? step.outMessage.url : "").toContain(
			"maple_gcp_connector_id",
		)
	})

	test("blocked site storage reads no removed connectors and drops the write", async () => {
		const blocked = () => Effect.die("storage is blocked")
		vi.stubGlobal("localStorage", {
			getItem: () => Effect.runSync(blocked()),
			setItem: () => Effect.runSync(blocked()),
		})
		const read = await Effect.runPromise(ReadRemoved({ orgId: "org_acme" }).effect)
		const written = await Effect.runPromise(WriteRemoved({ orgId: "org_acme", removed: [] }).effect)
		vi.unstubAllGlobals()
		expect(read).toEqual(GcpMessage.CompletedReadGcpRemoved({ removed: [] }))
		expect(written).toEqual(GcpMessage.CompletedWriteGcpRemoved())
	})

	describe("a connection's feature switches", () => {
		test("a switch opens Edit data with the flip drafted, and saving sends only that capability", () => {
			const model = loaded(true)
			const id = connectorId(model)
			if (id === undefined) throw new Error("no connector")
			const opened = pageUpdate(
				model,
				gcpMsg(GcpMessage.ToggledGcpFeature({ id, capability: "metrics" })),
			)
			expect(opened.model.gcpCard.configure?.target).toEqual({
				_tag: "Connection",
				id,
				stage: "choose",
			})
			expect(opened.model.gcpCard.configure?.chooseFlags).toEqual({
				logs_enabled: true,
				metrics_enabled: false,
				security_enabled: false,
			})
			// Metrics set up in Google Cloud stop at once in Maple, so the save asks first.
			const asked = pageUpdate(opened.model, gcpMsg(GcpMessage.ClickedGcpChooseApply()))
			const saved = pageUpdate(asked.model, gcpMsg(GcpMessage.ConfirmedGcpSave()))
			expect(Arr.map(saved.commands ?? [], ({ name, args }) => [name, args])).toEqual([
				["UpdateGcpConnector", expect.objectContaining({ id, payload: { metrics_enabled: false } })],
			])
		})

		test("the security findings switch sends only that capability", () => {
			const model = loaded(true)
			const id = connectorId(model)
			if (id === undefined) throw new Error("no connector")
			const opened = pageUpdate(
				model,
				gcpMsg(GcpMessage.ToggledGcpFeature({ id, capability: "security" })),
			)
			const saved = pageUpdate(opened.model, gcpMsg(GcpMessage.ClickedGcpChooseApply()))
			expect(Arr.map(saved.commands ?? [], ({ name, args }) => [name, args])).toEqual([
				["UpdateGcpConnector", expect.objectContaining({ id, payload: { security_enabled: true } })],
			])
		})

		test("security findings cannot be switched on where the deployment cannot read metrics", () => {
			scene(
				{ update: pageUpdate, view },
				given(loaded(true, { metrics_enabled: false, applied_metrics_enabled: false }, false)),
				expectView(role("switch", { name: "Security findings" })).toBeDisabled(),
				expectView(role("switch", { name: "Metrics and resources" })).toBeDisabled(),
			)
			scene(
				{ update: pageUpdate, view },
				given(loaded(true)),
				expectView(role("switch", { name: "Security findings" })).toBeEnabled(),
			)
		})

		test("the last capability on cannot be switched off", () => {
			scene(
				{ update: pageUpdate, view },
				given(loaded(true, { metrics_enabled: false, applied_metrics_enabled: false })),
				expectView(role("switch", { name: "Log forwarding" })).toBeDisabled(),
				expectView(role("switch", { name: "Metrics and resources" })).toBeEnabled(),
			)
		})

		test("a capability switched off but still set up in Google Cloud shows it is pending", () => {
			scene(
				{ update: pageUpdate, view },
				given(loaded(true, { metrics_enabled: false })),
				expectView(role("switch", { name: "Metrics and resources" })).toHaveAttr(
					"aria-checked",
					"false",
				),
				expectView(text("Still in Google Cloud")).toExist(),
			)
			scene(
				{ update: pageUpdate, view },
				given(loaded(true, { metrics_enabled: false, applied_metrics_enabled: false })),
				expectView(text("Still in Google Cloud")).not.toExist(),
			)
		})
	})
})
