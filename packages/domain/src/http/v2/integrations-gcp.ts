import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	GcpConnectorId,
	GcpLogRuntime,
	GcpProjectId,
	GcpResourceNumber,
	GcpScopeType,
} from "../../primitives"
import {
	GcpMetricsUnavailableError,
	GcpScopeAlreadyConnectedError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsValidationError,
} from "../integrations"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { V2InsufficientPermissions } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"

// Google Cloud integration. No OAuth: an org registers a connector for a project, a folder or a
// whole organization, and an administrator runs the generated `gcloud` script. The script routes
// logs through Pub/Sub to the ingest gateway if the connector opted in, and lets Maple read
// metrics and the resource inventory for every connector. Public v2 from the start so scripted
// setups can use a scoped API key.

/** `gcpc_…` public ID ⇄ internal `GcpConnectorId` (raw UUID). */
export const GcpConnectorPublicId = PublicId(PublicIdPrefixes.gcpConnector, GcpConnectorId)

const connectorExample = {
	id: "gcpc_YofPTrK9782DWwcnXhpcCw",
	object: "gcp_connector",
	scope_type: "organization",
	scope_id: "123456789012",
	project_id: "acme-observability",
	logs_enabled: true,
	metrics_enabled: true,
	created_at: "2026-10-01T12:00:00.000Z",
	last_log_received_at: "2026-10-08T09:12:00.000Z",
	last_log_error: null,
	applied_logs_enabled: true,
	applied_metrics_enabled: true,
	setup_reported_at: "2026-10-01T12:05:00.000Z",
	last_metrics_received_at: "2026-10-08T09:10:00.000Z",
	last_metrics_error: null,
	discovered_project_count: 14,
	last_resources_error: null,
} as const

export const V2GcpConnector = Schema.Struct({
	id: GcpConnectorPublicId,
	object: Schema.Literal("gcp_connector").annotate({
		description: 'The object type — always `"gcp_connector"`.',
	}),
	scope_type: GcpScopeType.annotate({
		description:
			"What the connector covers: one `project`, or every project under a `folder` or `organization`, including projects created later.",
		examples: ["organization"],
	}),
	scope_id: Schema.String.annotate({
		description: "The project ID, or the numeric folder or organization ID, named by `scope_type`.",
		examples: ["123456789012"],
	}),
	project_id: Schema.String.annotate({
		description:
			"The host project: where the setup script creates Maple's own resources (Pub/Sub topic, subscription, service account). Equal to `scope_id` for a `project` scope.",
		examples: ["acme-observability"],
	}),
	logs_enabled: Schema.Boolean.annotate({
		description: "Whether the setup script forwards logs to Maple.",
		examples: [true],
	}),
	metrics_enabled: Schema.Boolean.annotate({
		description:
			"Whether Maple collects the scope's key Cloud Monitoring metrics every 5 minutes (for alert rules, the Infrastructure page and the Google Cloud dashboard template) and syncs its Cloud Asset resource inventory every hour. A change takes effect in Maple at once: the setup script does not depend on it. Collection and live metric queries both read as the read-only service account (see `applied_metrics_enabled`).",
		examples: [true],
	}),
	created_at: Timestamp.annotate({ description: "When the connector was created." }),
	last_log_received_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When Maple last accepted a log push from this connector, or `null` before the first one. Stays `null` until the setup script has run.",
	}),
	last_log_error: Schema.NullOr(Schema.String).annotate({
		description: "Why the most recent log push was rejected, or `null`.",
		examples: [null],
	}),
	applied_logs_enabled: Schema.NullOr(Schema.Boolean).annotate({
		description:
			"Whether log forwarding is set up in Google Cloud, as the latest setup script run reported it. `null` until a run reports. The setup script has to run while `logs_enabled` is `true` and this is not, or `logs_enabled` is `false` and this is `true`.",
		examples: [true],
	}),
	applied_metrics_enabled: Schema.NullOr(Schema.Boolean).annotate({
		description:
			"Whether the read-only service account Maple reads metrics and resources as is in place in Google Cloud, as the latest setup or cleanup script run reported it. `null` until a run reports. Live queries and, with `metrics_enabled`, collection need it. The setup script creates it for every connector while `metrics_available` is `true`: run it while this is not `true`.",
		examples: [true],
	}),
	setup_reported_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When a setup or cleanup script run last reported to Maple, or `null`. A run reports within seconds of finishing, before its first log or metric arrives.",
	}),
	last_metrics_received_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When Maple last collected the scope's key metrics, or `null` before the first successful read. Only connectors with `metrics_enabled` are collected.",
	}),
	last_metrics_error: Schema.NullOr(Schema.String).annotate({
		description:
			"Why the most recent metrics read failed or was incomplete and what to do about it, or `null`. Before the setup script has run it says that Maple cannot sign in yet: `applied_metrics_enabled` tells that state apart.",
		examples: [null],
	}),
	discovered_project_count: Schema.Number.annotate({
		description:
			"How many projects the latest resource sync found in the scope. `0` until the first sync; a `project` scope reports `1`.",
		examples: [14],
	}),
	last_resources_error: Schema.NullOr(Schema.String).annotate({
		description: "Why the most recent resource sync failed or was incomplete, or `null`.",
		examples: [null],
	}),
}).annotate({
	identifier: "GcpConnector",
	title: "Google Cloud connector",
	description: "One connected Google Cloud project, folder or organization.",
	examples: [wireExample(connectorExample)],
})
export type V2GcpConnector = Schema.Schema.Type<typeof V2GcpConnector>

export const V2GcpIntegration = Schema.Struct({
	object: Schema.Literal("gcp_integration").annotate({
		description: 'The object type — always `"gcp_integration"`.',
	}),
	metrics_available: Schema.Boolean.annotate({
		description:
			"Whether this Maple deployment has a Google identity to read Google Cloud metrics with: live queries on every connector, and key-metrics collection. When `false`, `metrics_enabled` cannot be turned on and `logs_enabled` must stay `true`.",
		examples: [true],
	}),
	connectors: Schema.Array(V2GcpConnector).annotate({
		description: "Every connector of the organization, oldest first.",
	}),
}).annotate({
	identifier: "GcpIntegration",
	title: "Google Cloud integration status",
	description:
		'The Google Cloud integration state for the authenticated organization. Note: `connectors` is **not** the standard `{ object: "list", data, has_more, next_cursor }` envelope: an organization has a handful of connectors and they are returned whole next to `metrics_available`.',
	examples: [
		wireExample({ object: "gcp_integration", metrics_available: true, connectors: [connectorExample] }),
	],
})
export type V2GcpIntegration = Schema.Schema.Type<typeof V2GcpIntegration>

const logsEnabledField = Schema.optionalKey(Schema.Boolean).annotate({
	description:
		"Forward logs to Maple. Google Cloud follows once the setup script has run. Must stay `true` when the status reports `metrics_available: false`.",
	examples: [true],
})
const metricsEnabledField = Schema.optionalKey(Schema.Boolean).annotate({
	description:
		"Collect key metrics every 5 minutes and the resource inventory every hour. Takes effect in Maple at once: the setup script does not depend on it. Rejected when the status reports `metrics_available: false`.",
	examples: [false],
})

export const V2GcpCreateConnectorRequest = Schema.Union([
	Schema.Struct({
		scope_type: Schema.Literal("project"),
		scope_id: GcpProjectId.annotate({ description: "The project ID (not its name or number)." }),
		project_id: Schema.optionalKey(GcpProjectId).annotate({
			description: "A project is its own host project: omit this, or repeat `scope_id`.",
		}),
		logs_enabled: logsEnabledField,
		metrics_enabled: metricsEnabledField,
	})
		.check(
			// Returns the message: a filter's `description` is not what surfaces on failure.
			Schema.makeFilter(
				(value) =>
					value.project_id === undefined ||
					value.project_id === value.scope_id ||
					"project_id must be omitted or equal scope_id when scope_type is project",
			),
		)
		.annotate({ identifier: "GcpCreateProjectConnector", title: "Project connector" }),
	Schema.Struct({
		scope_type: Schema.Literals(["folder", "organization"]),
		scope_id: GcpResourceNumber.annotate({ description: "The numeric folder or organization ID." }),
		project_id: GcpProjectId.annotate({
			description:
				"The host project for Maple's own resources (Pub/Sub topic, subscription, service account): a project ID, usually a project inside the folder or organization.",
		}),
		logs_enabled: logsEnabledField,
		metrics_enabled: metricsEnabledField,
	}).annotate({ identifier: "GcpCreateAggregatedConnector", title: "Folder or organization connector" }),
]).annotate({
	identifier: "GcpCreateConnectorRequest",
	title: "Google Cloud connector create request",
	description:
		"What to connect, discriminated on `scope_type`. `logs_enabled` defaults to `true` and `metrics_enabled` to `false`. Both may be off, for a connector that serves live metric queries only, unless the status reports `metrics_available: false`.",
	examples: [
		wireExample({ scope_type: "project", scope_id: "acme-prod" }),
		wireExample({
			scope_type: "organization",
			scope_id: "123456789012",
			project_id: "acme-observability",
			metrics_enabled: true,
		}),
	],
})
export type V2GcpCreateConnectorRequest = Schema.Schema.Type<typeof V2GcpCreateConnectorRequest>

export const V2GcpUpdateConnectorRequest = Schema.Struct({
	logs_enabled: logsEnabledField,
	metrics_enabled: metricsEnabledField,
}).annotate({
	identifier: "GcpUpdateConnectorRequest",
	title: "Google Cloud connector update request",
	description:
		"What the connector collects; omitted fields are unchanged. Delete the connector to disconnect.",
	examples: [wireExample({ metrics_enabled: true })],
})
export type V2GcpUpdateConnectorRequest = Schema.Schema.Type<typeof V2GcpUpdateConnectorRequest>

export const V2GcpSetupScriptsRequest = Schema.Struct({
	application_logs: Schema.optionalKey(Schema.Array(GcpLogRuntime)).annotate({
		description:
			"The runtimes whose application output (what their code writes to stdout and stderr) the log sink forwards. Platform, request and audit logs are forwarded either way. Omitted: a sink that already exists keeps its filter, and a new one forwards no application output: workloads send it over OpenTelemetry. Given: the script sets the filter to exactly this list, and an empty list forwards no application output. A workload that also sends its logs to Maple over OpenTelemetry has each line stored twice.",
		examples: [["cloud_run", "cloud_functions", "app_engine"]],
	}),
}).annotate({
	identifier: "GcpSetupScriptsRequest",
	title: "Google Cloud setup scripts request",
	description: "Options for rendering a connector's scripts.",
	examples: [wireExample({ application_logs: ["cloud_run", "cloud_functions", "app_engine"] })],
})
export type V2GcpSetupScriptsRequest = Schema.Schema.Type<typeof V2GcpSetupScriptsRequest>

// What a script field holds: the script as a here-document for a bash process of its own.
const SCRIPT_EXAMPLE =
	" { …\nbash /dev/fd/3 3<<'MAPLE_SETUP_SCRIPT'\n#!/usr/bin/env bash\n…\nMAPLE_SETUP_SCRIPT\n}\n"

export const V2GcpSetupScripts = Schema.Struct({
	object: Schema.Literal("gcp_connector.setup_scripts").annotate({
		description: 'The object type — always `"gcp_connector.setup_scripts"`.',
	}),
	setup_script: Schema.String.annotate({
		description:
			"Text to paste into Cloud Shell: a bash script, wrapped so that it runs in a bash process of its own. It sets up log forwarding while `logs_enabled` is `true` and removes it while it is not, creates the read-only service account Maple reads metrics as, and tells Maple what it applied, so run it again after changing `logs_enabled`. `metrics_enabled` does not change it. It embeds the connector's push secret: treat it as a credential.",
		examples: [SCRIPT_EXAMPLE],
	}),
	cleanup_script: Schema.String.annotate({
		description:
			"Text to paste into Cloud Shell that removes everything the setup script created and tells Maple that it ran. It embeds the connector's push secret: treat it as a credential.",
		examples: [SCRIPT_EXAMPLE],
	}),
}).annotate({
	identifier: "GcpSetupScripts",
	title: "Google Cloud setup scripts",
	description: "The scripts that connect and disconnect one Google Cloud project, folder or organization.",
	examples: [
		wireExample({
			object: "gcp_connector.setup_scripts",
			setup_script: SCRIPT_EXAMPLE,
			cleanup_script: SCRIPT_EXAMPLE,
		}),
	],
})
export type V2GcpSetupScripts = Schema.Schema.Type<typeof V2GcpSetupScripts>

export const V2GcpConnectorDeleteResponse = Schema.Struct({
	id: GcpConnectorPublicId,
	object: Schema.Literal("gcp_connector").annotate({
		description: 'The object type — always `"gcp_connector"`.',
	}),
	deleted: Schema.Literal(true).annotate({
		description: "Always `true` — the connector no longer exists and Maple rejects its log pushes.",
	}),
	cleanup_script: Schema.String.annotate({
		description:
			"Text to paste into Cloud Shell that removes the resources the setup script created. Maple has no write access to Google Cloud, so an administrator runs it. The connector is gone, so this copy carries no secret.",
		examples: [SCRIPT_EXAMPLE],
	}),
}).annotate({
	identifier: "GcpConnectorDeleteResponse",
	title: "Google Cloud connector delete response",
	description: "Confirmation that a connector was deleted, with the script that cleans up Google Cloud.",
	examples: [
		wireExample({
			id: connectorExample.id,
			object: "gcp_connector",
			deleted: true,
			cleanup_script: SCRIPT_EXAMPLE,
		}),
	],
})
export type V2GcpConnectorDeleteResponse = Schema.Schema.Type<typeof V2GcpConnectorDeleteResponse>

const [scopeAlreadyConnected, metricsUnavailable, validation, connectorNotFound, integrationPersistence] =
	publicErrors(
		GcpScopeAlreadyConnectedError,
		GcpMetricsUnavailableError,
		IntegrationsValidationError,
		IntegrationsNotFoundError,
		IntegrationsPersistenceError,
	)

export class V2GcpIntegrationsApiGroup extends HttpApiGroup.make("gcpIntegration")
	.add(
		HttpApiEndpoint.get("status", "/", {
			success: V2GcpIntegration,
			error: [integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getGcpIntegration",
				summary: "Retrieve Google Cloud integration status",
				description:
					"Returns the organization's Google Cloud connectors with what their setup script last reported and the time and outcome of their latest log push, and whether this deployment can read Google Cloud metrics. Requires the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("createConnector", "/connectors", {
			payload: V2GcpCreateConnectorRequest,
			success: V2GcpConnector,
			error: [
				V2InsufficientPermissions.schema,
				scopeAlreadyConnected,
				metricsUnavailable,
				validation,
				integrationPersistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createGcpConnector",
				summary: "Connect a Google Cloud project, folder or organization",
				description:
					"Registers a connector for one project, or for every project under a folder or organization. Nothing reaches Maple until an administrator runs the script from `setup_scripts`. A project, folder or organization can be connected once per Maple organization. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("updateConnector", "/connectors/:id", {
			params: { id: GcpConnectorPublicId },
			payload: V2GcpUpdateConnectorRequest,
			success: V2GcpConnector,
			error: [
				V2InsufficientPermissions.schema,
				connectorNotFound,
				metricsUnavailable,
				validation,
				integrationPersistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateGcpConnector",
				summary: "Change what a connector collects",
				description:
					"Turns log forwarding or key-metrics collection on or off. Key-metrics collection changes in Maple at once. Maple cannot change Google Cloud itself: after changing `logs_enabled`, re-run the script from `setup_scripts`, which sets up or removes the log sink. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("setupScripts", "/connectors/:id/setup_scripts", {
			params: { id: GcpConnectorPublicId },
			payload: V2GcpSetupScriptsRequest,
			success: V2GcpSetupScripts,
			error: [V2InsufficientPermissions.schema, connectorNotFound, integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "renderGcpConnectorSetupScripts",
				summary: "Render a connector's setup and cleanup scripts",
				description:
					"Returns the `gcloud` scripts for one connector. Rendering changes nothing, but both scripts carry the connector's push secret, so this requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("deleteConnector", "/connectors/:id", {
			params: { id: GcpConnectorPublicId },
			success: V2GcpConnectorDeleteResponse,
			error: [V2InsufficientPermissions.schema, connectorNotFound, integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteGcpConnector",
				summary: "Disconnect a Google Cloud project, folder or organization",
				description:
					"Deletes the connector, after which Maple rejects its log pushes and stops reading its metrics. Already-ingested data is unaffected. The response carries the cleanup script to run in Google Cloud. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.prefix("/v2/integrations/gcp")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Google Cloud Integration",
			description:
				"Connect Google Cloud projects, folders or organizations: register a connector, choose whether it forwards logs and whether Maple collects key metrics and resources, fetch the `gcloud` scripts that set it up, and see whether logs are arriving.",
		}),
	) {}
