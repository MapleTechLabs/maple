import { OrgId } from "@maple/domain"
import { encodePublicId, PublicIdPrefixes, V2GcpConnector, V2GcpIntegration } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import * as Field from "../../ui/field"
import type { PageContext } from "../contract"
import { Message as PageMessage } from "../sources/new/message"
import type { Model as PageModel } from "../sources/new/model"
import { init, update } from "../sources/new/update"
import { view as pageView } from "../sources/new/view"
import { Message } from "./message"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: PageModel, message: PageMessage) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const send = (model: PageModel, messages: ReadonlyArray<Message>) =>
	messages.reduce(
		(current, message) => pageUpdate(current, PageMessage.GotIntegrationsMessage({ message })).model,
		model,
	)

const NOW = Date.parse("2026-10-24T12:00:00.000Z")
const id = encodePublicId(PublicIdPrefixes.gcpConnector, "00000000-0000-4000-8000-000000000501")

const connector = (fields: Readonly<Record<string, unknown>> = {}) =>
	Schema.decodeUnknownSync(V2GcpConnector)({
		id,
		object: "gcp_connector",
		scope_type: "project",
		scope_id: "acme-prod",
		project_id: "acme-prod",
		logs_enabled: true,
		metrics_enabled: true,
		created_at: "2026-10-24T11:59:00.000Z",
		last_log_received_at: null,
		last_log_error: null,
		applied_logs_enabled: null,
		applied_metrics_enabled: null,
		setup_reported_at: null,
		last_metrics_received_at: null,
		last_metrics_error: null,
		discovered_project_count: 0,
		last_resources_error: null,
		...fields,
	})

const statusOf = (model: PageModel, connectors: ReadonlyArray<V2GcpConnector>): Message =>
	Message.CompletedLoadGcp({
		key: model.integrations.statuses.gcp.key ?? "",
		result: Result.succeed(
			Schema.decodeUnknownSync(V2GcpIntegration)({
				object: "gcp_integration",
				metrics_available: true,
				connectors: connectors.map((entry) => Schema.encodeSync(V2GcpConnector)(entry)),
			}),
		),
	})

const typed = (value: string): ReadonlyArray<Message> => [
	Message.GotGcpScopeFieldMessage({ field: "scopeId", message: Field.Message.ChangedValue({ value }) }),
	Message.GotGcpScopeFieldMessage({ field: "scopeId", message: Field.Message.BlurredControl() }),
]

const entered = (): PageModel => {
	const start = init({ _tag: "SourcesNew", search: { integration: "gcp" } }, context).model
	return send(start, [Message.CompletedReadClock({ nowMs: NOW }), statusOf(start, [])])
}

/** Through Connect and Choose data: the connection is created and Go live shows. */
const created = (fields: Readonly<Record<string, unknown>> = {}): PageModel => {
	const choose = pageUpdate(send(entered(), typed("acme-prod")), PageMessage.ClickedContinue()).model
	const made = send(choose, [
		Message.SubmittedGcpCreate(),
		Message.CompletedGcpCreate({ opens: 0, connector: connector(), failure: null }),
	])
	const listed = send(made, [statusOf(made, [connector(fields)])])
	return pageUpdate(listed, PageMessage.ClickedContinue()).model
}

describe("google cloud connect flow", () => {
	test("Connect waits for a valid ID, then Continue leads to Choose data", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered()),
			expectView(role("listitem", { current: "step", name: "Connect" })).toExist(),
			expectView(text("Enter the Project ID. Maple checks access when the setup runs.")).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
		scene(
			{ update: pageUpdate, view },
			given(send(entered(), typed("Acme_Prod"))),
			expectView(text("That doesn't look like a Project ID.")).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
		scene(
			{ update: pageUpdate, view },
			given(send(entered(), typed("acme-prod"))),
			expectView(text("Project ID looks right. Maple checks access when the setup runs.")).toExist(),
			click(role("button", { name: "Continue" })),
			expectView(role("listitem", { current: "step", name: "Choose data" })).toExist(),
			expectView(role("listitem", { name: "Project acme-prod" })).toExist(),
			expectView(role("button", { name: "Create connection" })).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("the setup method is picked on Connect", () => {
		scene(
			{ update: pageUpdate, view },
			given(entered()),
			click(role("button", { name: /^Terraform/ })),
			expectView(role("button", { name: /^Terraform/, pressed: true })).toExist(),
			expectView(role("button", { name: /^Cloud Shell script/, pressed: false })).toExist(),
		)
	})

	test("once created, Go live shows the script and a checklist waiting on it", () => {
		scene(
			{ update: pageUpdate, view },
			given(created()),
			expectView(role("listitem", { current: "step", name: "Go live" })).toExist(),
			expectView(role("listitem", { name: "Logs + metrics" })).toExist(),
			expectView(text("Run this script in Cloud Shell")).toExist(),
			expectView(role("listitem", { name: /Script run/ })).toExist(),
			expectView(role("listitem", { name: /Logs arrive/ })).toExist(),
			expectView(role("listitem", { name: /Metrics arrive/ })).toExist(),
			expectView(text("Waiting for the script to report back")).toExist(),
		)
	})

	test("data arriving after the run marks the flow live", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				created({
					applied_logs_enabled: true,
					applied_metrics_enabled: true,
					setup_reported_at: "2026-10-24T11:59:30.000Z",
					last_log_received_at: "2026-10-24T11:59:50.000Z",
					last_metrics_received_at: "2026-10-24T11:59:50.000Z",
				}),
			),
			expectView(role("listitem", { name: "Live" })).toExist(),
			expectView(text("Confirmed: data shows up in Maple on its own from now on.")).toExist(),
			expectView(text("Run this script in Cloud Shell")).not.toExist(),
		)
	})
})
