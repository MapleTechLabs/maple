import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { GcpConnectorId, GcpLogFilter, GcpProjectId, GcpResourceNumber, GcpScopeType } from "../../primitives"
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
// logs through Pub/Sub to the ingest gateway and lets Maple read metrics and the resource
// inventory, each only if the connector opted in. Public v2 from the start so scripted setups can
// use a scoped API key.

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
			"Whether the setup script lets Maple read Cloud Monitoring metrics and the Cloud Asset resource inventory.",
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
			"Whether log forwarding is set up in Google Cloud, as the latest setup script run reported it. `null` until a run reports. While it differs from `logs_enabled`, the setup script has to run again.",
		examples: [true],
	}),
	applied_metrics_enabled: Schema.NullOr(Schema.Boolean).annotate({
		description:
			"Whether metrics and resource access is set up in Google Cloud, as the latest setup script run reported it. `null` until a run reports. While it differs from `metrics_enabled`, the setup script has to run again.",
		examples: [true],
	}),
	setup_reported_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When a setup or cleanup script run last reported to Maple, or `null`. A run reports within seconds of finishing, before its first log or metric arrives.",
	}),
	last_metrics_received_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When Maple last read the scope's metrics, or `null` before the first successful read. Stays `null` until the setup script has run with `metrics_enabled`.",
	}),
	last_metrics_error: Schema.NullOr(Schema.String).annotate({
		description:
			"Why the most recent metrics read failed or was incomplete, or `null`. Before the setup script has run it says that Maple has no access yet.",
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
			"Whether this Maple deployment can collect metrics and resources from Google Cloud. When `false`, `metrics_enabled` cannot be turned on.",
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
	description: "Forward logs to Maple.",
	examples: [true],
})
const metricsEnabledField = Schema.optionalKey(Schema.Boolean).annotate({
	description:
		"Let Maple read metrics and the resource inventory. Rejected when the status reports `metrics_available: false`.",
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
		"What to connect, discriminated on `scope_type`. `logs_enabled` defaults to `true` and `metrics_enabled` to `false`; at least one must be on.",
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
		"What the connector collects; omitted fields are unchanged. At least one must stay on: delete the connector to disconnect.",
	examples: [wireExample({ metrics_enabled: true })],
})
export type V2GcpUpdateConnectorRequest = Schema.Schema.Type<typeof V2GcpUpdateConnectorRequest>

export const V2GcpSetupScriptsRequest = Schema.Struct({
	log_filter: Schema.optionalKey(GcpLogFilter).annotate({
		description:
			"The log filter the setup script carries. `keep` (the default): a sink that already exists keeps its filter, and a new one gets Maple's default. `default`: the script sets Maple's default, which leaves out Data Access audit logs and load balancer health checks. `exclude_gke_container_logs`: the script sets the default without GKE container logs, for pods that already ship their logs to Maple through an OpenTelemetry collector.",
		examples: ["keep"],
	}),
}).annotate({
	identifier: "GcpSetupScriptsRequest",
	title: "Google Cloud setup scripts request",
	description: "Options for rendering a connector's scripts.",
	examples: [wireExample({ log_filter: "exclude_gke_container_logs" })],
})

// What a script field holds: the script as a here-document for a bash process of its own.
const SCRIPT_EXAMPLE =
	" { …\nbash /dev/fd/3 3<<'MAPLE_SETUP_SCRIPT'\n#!/usr/bin/env bash\n…\nMAPLE_SETUP_SCRIPT\n}\n"
export type V2GcpSetupScriptsRequest = Schema.Schema.Type<typeof V2GcpSetupScriptsRequest>

export const V2GcpSetupScripts = Schema.Struct({
	object: Schema.Literal("gcp_connector.setup_scripts").annotate({
		description: 'The object type — always `"gcp_connector.setup_scripts"`.',
	}),
	setup_script: Schema.String.annotate({
		description:
			"Text to paste into Cloud Shell: a bash script, wrapped so that it runs in a bash process of its own. It sets up what the connector has enabled, removes what it has not, and tells Maple what it applied, so run it again after changing `logs_enabled` or `metrics_enabled`. It embeds the connector's push secret: treat it as a credential.",
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
					"Returns the organization's Google Cloud connectors with what their setup script last reported and the time and outcome of their latest log push, and whether metrics collection is available. Requires the `integrations:read` scope.",
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
					"Turns log forwarding or metrics and resource collection on or off. Maple cannot change Google Cloud itself: re-run the script from `setup_scripts` afterwards, which sets up what is now enabled and removes what is not. Requires an org-admin role and the `integrations:write` scope.",
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
				"Connect Google Cloud projects, folders or organizations: register a connector, choose whether it forwards logs and whether Maple may read metrics and resources, fetch the `gcloud` scripts that set it up, and see whether logs are arriving.",
		}),
	) {}
