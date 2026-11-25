import { GcpConnectorId, GcpProjectId, GcpResourceNumber, GcpScopeType } from "@maple/primitives"
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SessionAuthorization } from "./current-tenant"
import {
	IntegrationsForbiddenError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsValidationError,
} from "./integrations"
import { EndpointAccess } from "./endpoint-access"

/** A GCP connection a billing export can be read through. */
export const GcpCostConnector = Schema.Struct({
	id: GcpConnectorId,
	scopeType: GcpScopeType,
	scopeId: Schema.Union([GcpProjectId, GcpResourceNumber]),
	/** The host project: BigQuery runs, and bills, the cost query here. */
	projectId: GcpProjectId,
	/** The reader account exists only while Metrics and resources is on. */
	metricsEnabled: Schema.Boolean,
	/** The account to grant BigQuery Data Viewer and Job User. */
	readerEmail: Schema.String,
})
export type GcpCostConnector = typeof GcpCostConnector.Type

/** A billing export the org reads its Google Cloud spend from. */
export const GcpCostExport = Schema.Struct({
	id: Schema.String,
	connectorId: GcpConnectorId,
	/** `project.dataset.table`. */
	tableRef: Schema.String,
	billingAccountId: Schema.String,
	/** The detailed export, which names each resource. */
	detailed: Schema.Boolean,
})
export type GcpCostExport = typeof GcpCostExport.Type

export class GcpCostStatus extends Schema.Class<GcpCostStatus>("GcpCostStatus")({
	connectors: Schema.Array(GcpCostConnector),
	exports: Schema.Array(GcpCostExport),
}) {}

export class GcpCostAddRequest extends Schema.Class<GcpCostAddRequest>("GcpCostAddRequest")({
	connectorId: GcpConnectorId,
	/** As the BigQuery console copies it: `project.dataset.table` or `project:dataset.table`. */
	tableRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1200)),
}) {}

export class GcpCostSourceAdded extends Schema.Class<GcpCostSourceAdded>("GcpCostSourceAdded")({
	export: GcpCostExport,
	/** False when the org read that table already: nothing changed. */
	created: Schema.Boolean,
}) {}

export class GcpCostSourceRemoved extends Schema.Class<GcpCostSourceRemoved>("GcpCostSourceRemoved")({
	/** False when there was no such export to remove. */
	removed: Schema.Boolean,
}) {}

const exportParams = { exportId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)) }

/**
 * Google Cloud cost sources: a Cloud Billing export to BigQuery, read as the reader account of one
 * of the org's GCP connections. Adding one saves the export and makes the source; the first sync
 * says whether the reader can query it.
 */
export class GcpCostApiGroup extends HttpApiGroup.make("gcpCost")
	.add(
		HttpApiEndpoint.get("status", "/", {
			success: GcpCostStatus,
			error: [IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.put("add", "/", {
			payload: GcpCostAddRequest,
			success: GcpCostSourceAdded,
			error: [
				IntegrationsPersistenceError,
				IntegrationsForbiddenError,
				IntegrationsNotConnectedError,
				IntegrationsValidationError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/:exportId", {
			params: exportParams,
			success: GcpCostSourceRemoved,
			error: [IntegrationsPersistenceError, IntegrationsForbiddenError],
		}),
	)
	.prefix("/internal/cost/gcp")
	.middleware(SessionAuthorization)
	.annotate(EndpointAccess, "handler") {}
