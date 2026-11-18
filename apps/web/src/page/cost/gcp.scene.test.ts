import { OrgId } from "@maple/domain"
import {
	CostSourcesResponse,
	GcpCostConnector,
	GcpCostSourceAdded,
	GcpCostSourceRemoved,
	GcpCostStatus,
} from "@maple/domain/http"
import { CostSourceId, GcpConnectorId } from "@maple/primitives"
import { Array as Arr, Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { ResolveThemeColors, ThemeMessage } from "@maple/views/charts/theme-colors"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../contract"
import { bqTableOf, gcpGrantCommands } from "./gcp-export"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const window = { startTime: "2026-10-12 00:00:00", endTime: "2026-11-10 14:30:00" }
const NOW = Date.UTC(2026, 10, 10, 14, 30)

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const resolveTheme = Mount.resolve(ResolveThemeColors, ThemeMessage.ResolvedThemeColors({ colors: {} }))
const dialogMounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const CONNECTOR_A = "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
const CONNECTOR_B = "028f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
const TABLE = "billing-proj.exports.gcp_billing_export_resource_v1_01ABCD_234567_89ABCD"
const READER_A = "maple-018f2b3c4d5e4f708192a3b4@acme-prod.iam.gserviceaccount.com"

type ConnectorWire = (typeof GcpCostStatus.Encoded)["connectors"][number]

const connector = (over: Partial<ConnectorWire> = {}): ConnectorWire => ({
	id: CONNECTOR_A,
	scopeType: "project",
	scopeId: "acme-prod",
	projectId: "acme-prod",
	metricsEnabled: true,
	readerEmail: READER_A,
	...over,
})

const status = (connectors: ReadonlyArray<ConnectorWire>) =>
	Schema.decodeSync(GcpCostStatus)({ connectors, exports: [] })

/** The page with no sources, its add dialog turned to Google Cloud, the read in flight. */
const opened = () => {
	const resolved = pageUpdate(
		init({ search: {} }, context).model,
		Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
	).model
	const entered = pageUpdate(
		resolved,
		Message.CompletedLoadSources({
			key: resolved.sources.key ?? "",
			result: Result.succeed(Schema.decodeSync(CostSourcesResponse)({ sources: [] })),
		}),
	).model
	return pageUpdate(pageUpdate(entered, Message.ClickedAddSource()).model, Message.ClickedAddGcp())
}

const stepWith = (answer: GcpCostStatus): Model => {
	const model = opened().model
	return pageUpdate(
		model,
		Message.CompletedLoadGcpStatus({ key: model.gcp.key ?? "", result: Result.succeed(answer) }),
	).model
}

const typed = (model: Model, value: string): Model =>
	pageUpdate(model, Message.GotGcpTableDraftMessage({ message: Field.Message.ChangedValue({ value }) }))
		.model

describe("grant commands", () => {
	test("name the reader account, the host project, and the typed table as bq writes it", () => {
		const commands = gcpGrantCommands(Schema.decodeSync(GcpCostConnector)(connector()), TABLE)
		expect(commands).toContain("gcloud services enable bigquery.googleapis.com --project=acme-prod")
		expect(commands).toContain(`--member=serviceAccount:${READER_A} \\\n  --role=roles/bigquery.jobUser`)
		expect(commands).toContain("billing-proj:exports.gcp_billing_export_resource_v1_01ABCD_234567_89ABCD")
		expect(bqTableOf("not a table")._tag).toBe("None")
	})
})

describe("the Google Cloud step", () => {
	test("reads the org's connections, takes a table id and adds it through the one connection", () => {
		expect(names(opened().commands)).toEqual(["FetchGcpCostStatus"])
		const ready = stepWith(status([connector()]))
		scene(
			{ update: pageUpdate, view },
			given(ready),
			resolveTheme,
			dialogMounted,
			expectView(text("Add Google Cloud")).toExist(),
			expectView(text("acme-prod")).toExist(),
			expectView(text(/Billing export table/)).toExist(),
			// Nothing typed yet: nothing to add.
			expectView(role("button", { name: "Add source" })).toBeDisabled(),
		)
		expect(names(pageUpdate(ready, Message.SubmittedGcpExport()).commands)).toEqual([])

		const filled = typed(ready, TABLE)
		scene(
			{ update: pageUpdate, view },
			given(filled),
			resolveTheme,
			dialogMounted,
			expectView(role("button", { name: "Add source" })).toBeEnabled(),
		)
		const adding = pageUpdate(filled, Message.SubmittedGcpExport())
		expect(adding.commands).toMatchObject([
			{ name: "AddGcpCostSource", args: { connectorId: CONNECTOR_A, tableRef: TABLE } },
		])
		expect(names(pageUpdate(adding.model, Message.SubmittedGcpExport()).commands)).toEqual([])

		const added = pageUpdate(
			adding.model,
			Message.CompletedAddGcp({
				result: Result.succeed(
					Schema.decodeSync(GcpCostSourceAdded)({
						export: {
							id: "export_1",
							connectorId: CONNECTOR_A,
							tableRef: TABLE,
							billingAccountId: "01ABCD-234567-89ABCD",
							detailed: true,
						},
						created: true,
					}),
				),
			}),
		)
		expect(added.model.addDialog.isOpen).toBe(false)
		expect(names(added.commands)).toContain("FetchCostSources")
		expect(added.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Google Cloud added",
				description:
					"The first sync of billing account 01ABCD-234567-89ABCD runs within a few minutes.",
			}),
		)
	})

	test("adds through the connection picked, and never one without a reader account", () => {
		const ready = stepWith(
			status([
				connector({
					id: CONNECTOR_B,
					scopeId: "acme-staging",
					projectId: "acme-staging",
					metricsEnabled: false,
				}),
				connector(),
				connector({
					id: "038f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
					scopeId: "acme-ops",
					projectId: "acme-ops",
				}),
			]),
		)
		scene(
			{ update: pageUpdate, view },
			given(ready),
			resolveTheme,
			dialogMounted,
			expectView(text("Turn on Metrics and resources for this connection first")).toExist(),
		)
		// The first connection with a reader is the default; one without cannot be picked.
		const viaDefault = pageUpdate(typed(ready, TABLE), Message.SubmittedGcpExport())
		expect(viaDefault.commands).toMatchObject([{ args: { connectorId: CONNECTOR_A } }])
		const pickedOff = pageUpdate(
			ready,
			Message.PickedGcpConnector({ connectorId: Schema.decodeSync(GcpConnectorId)(CONNECTOR_B) }),
		)
		expect(
			pageUpdate(typed(pickedOff.model, TABLE), Message.SubmittedGcpExport()).commands,
		).toMatchObject([{ args: { connectorId: CONNECTOR_A } }])
	})

	test("an org with no connection is sent to connect Google Cloud", () => {
		scene(
			{ update: pageUpdate, view },
			given(stepWith(status([]))),
			resolveTheme,
			dialogMounted,
			expectView(text(/No Google Cloud project is connected yet/)).toExist(),
			expectView(role("link", { name: "Connect Google Cloud" })).toHaveAttr(
				"href",
				"/sources/new?integration=gcp",
			),
		)
	})

	test("a refused add stays in the dialog with the reason under the field, until the id changes", () => {
		const adding = pageUpdate(
			typed(stepWith(status([connector()])), "acme.x.y"),
			Message.SubmittedGcpExport(),
		)
		const refused = pageUpdate(
			adding.model,
			Message.CompletedAddGcp({
				result: Result.fail({
					...toLoadFailure("refused"),
					message: "That is not a Cloud Billing export table.",
				}),
			}),
		)
		expect(refused.model.addDialog.isOpen).toBe(true)
		expect(refused.model.gcpError).toBe("That is not a Cloud Billing export table.")
		expect(names(refused.commands)).toEqual(["FetchGcpCostStatus"])
		expect(typed(refused.model, TABLE).gcpError).toBeNull()
	})

	test("removing a Google Cloud source removes its export by the source's connection", () => {
		const resolved = pageUpdate(
			init({ search: {} }, context).model,
			Message.CompletedResolveWindow({ window, nowMs: NOW, mode: "Load" }),
		).model
		const sourceId = Schema.decodeSync(CostSourceId)("0190f2b3-0000-7000-8000-00000000c070")
		const model = pageUpdate(
			resolved,
			Message.CompletedLoadSources({
				key: resolved.sources.key ?? "",
				result: Result.succeed(
					Schema.decodeSync(CostSourcesResponse)({
						sources: [
							{
								id: sourceId,
								provider: "gcp",
								connectionRef: "export_1",
								accountId: "01ABCD-234567-89ABCD",
								status: "ok",
								watermarkDate: "2026-11-09",
								backfillDate: "2025-10-01",
								historyComplete: true,
								lastSyncedAt: NOW,
								lastError: null,
								lastErrorReason: null,
								requestsThisMonth: 12,
							},
						],
					}),
				),
			}),
		).model
		const confirming = pageUpdate(model, Message.ClickedRemoveSource({ sourceId })).model
		scene(
			{ update: pageUpdate, view },
			given(confirming),
			resolveTheme,
			dialogMounted,
			expectView(text("Remove the Google Cloud source?")).toExist(),
		)
		const removing = pageUpdate(confirming, Message.ClickedConfirmRemove())
		expect(removing.commands).toMatchObject([
			{ name: "RemoveGcpCostSource", args: { exportId: "export_1" } },
		])
		const done = pageUpdate(
			removing.model,
			Message.CompletedRemoveGcp({
				result: Result.succeed(new GcpCostSourceRemoved({ removed: true })),
			}),
		)
		expect(done.outMessage).toMatchObject({ type: "success", title: "Google Cloud removed" })
	})
})
