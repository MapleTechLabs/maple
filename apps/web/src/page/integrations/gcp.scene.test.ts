import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2GcpIntegration } from "@maple/domain/http/v2"
import { Effect, Result, Schema } from "effect"
import { describe, expect, test, vi } from "vitest"
import * as Menu from "../../ui/menu"
import { toLoadFailure } from "../../data/load-failure"
import type { PageContext } from "../contract"
import { ReadRemoved, WriteRemoved } from "./gcp"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const publicId = encodePublicId(PublicIdPrefixes.gcpConnector, "00000000-0000-4000-8000-000000000402")

const status = (applied: boolean | null) =>
	Schema.decodeUnknownSync(V2GcpIntegration)({
		object: "gcp_integration",
		metrics_available: true,
		connectors: [
			{
				id: publicId,
				object: "gcp_connector",
				scope_type: "project",
				scope_id: "acme-prod",
				project_id: "acme-prod",
				logs_enabled: true,
				metrics_enabled: true,
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
			},
		],
	})

const loaded = (applied: boolean | null): Model => {
	const start = init({ search: { integration: "gcp" } }, context).model
	const key = start.statuses.gcp.key ?? ""
	return pageUpdate(start, Message.CompletedLoadGcp({ key, result: Result.succeed(status(applied)) })).model
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
		Message.GotGcpMenuMessage({
			id,
			message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value } }),
		}),
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
		const sent = pageUpdate(opened, Message.ConfirmedGcpDisconnect())
		expect(names(sent.commands)).toEqual(["DeleteGcpConnector"])
		const id = connectorId(opened)
		if (id === undefined) throw new Error("no connector")
		const done = pageUpdate(
			sent.model,
			Message.CompletedGcpDisconnect({ id, cleanupScript: "echo bye", failure: null }),
		)
		expect(done.model.gcpCard.removed.map((entry) => entry.cleanupScript)).toEqual(["echo bye"])
		expect(names(done.commands)).toEqual(
			expect.arrayContaining(["WriteGcpRemovedConnectors", "LoadIntegrationsGcpStatus"]),
		)
		const failed = pageUpdate(
			sent.model,
			Message.CompletedGcpDisconnect({ id, cleanupScript: null, failure: toLoadFailure("nope") }),
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
		expect(read).toEqual(Message.CompletedReadGcpRemoved({ removed: [] }))
		expect(written).toEqual(Message.CompletedWriteGcpRemoved())
	})
})
