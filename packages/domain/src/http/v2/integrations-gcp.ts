import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { GcpConnectorId, GcpProjectId } from "../../primitives"
import {
	GcpProjectAlreadyConnectedError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
} from "../integrations"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { V2InsufficientPermissions } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"

// Google Cloud integration. No OAuth: an org registers a connector per Google Cloud project and
// its owner runs the generated `gcloud` script, which routes the project's logs through Pub/Sub
// to the ingest gateway. Public v2 from the start so scripted setups can use a scoped API key.

/** `gcpc_…` public ID ⇄ internal `GcpConnectorId` (raw UUID). */
export const GcpConnectorPublicId = PublicId(PublicIdPrefixes.gcpConnector, GcpConnectorId)

const connectorExample = {
	id: "gcpc_YofPTrK9782DWwcnXhpcCw",
	object: "gcp_connector",
	project_id: "acme-prod",
	created_at: "2026-10-01T12:00:00.000Z",
	last_log_received_at: "2026-10-08T09:12:00.000Z",
	last_log_error: null,
} as const

export const V2GcpConnector = Schema.Struct({
	id: GcpConnectorPublicId,
	object: Schema.Literal("gcp_connector").annotate({
		description: 'The object type — always `"gcp_connector"`.',
	}),
	project_id: Schema.String.annotate({
		description: "The Google Cloud project ID this connector receives from.",
		examples: ["acme-prod"],
	}),
	created_at: Timestamp.annotate({ description: "When the connector was created." }),
	last_log_received_at: Schema.NullOr(Timestamp).annotate({
		description:
			"When Maple last accepted a log push from this project, or `null` before the first one. Stays `null` until the setup script has run.",
	}),
	last_log_error: Schema.NullOr(Schema.String).annotate({
		description: "Why the most recent log push was rejected, or `null`.",
		examples: [null],
	}),
}).annotate({
	identifier: "GcpConnector",
	title: "Google Cloud connector",
	description: "One connected Google Cloud project.",
	examples: [wireExample(connectorExample)],
})
export type V2GcpConnector = Schema.Schema.Type<typeof V2GcpConnector>

export const V2GcpIntegration = Schema.Struct({
	object: Schema.Literal("gcp_integration").annotate({
		description: 'The object type — always `"gcp_integration"`.',
	}),
	metrics_available: Schema.Boolean.annotate({
		description:
			"Whether this Maple deployment can collect Cloud Monitoring metrics. When `false` connectors are logs-only and the setup script omits the metrics steps.",
		examples: [true],
	}),
	connectors: Schema.Array(V2GcpConnector).annotate({
		description: "Every connector of the organization, oldest first.",
	}),
}).annotate({
	identifier: "GcpIntegration",
	title: "Google Cloud integration status",
	description:
		'The Google Cloud integration state for the authenticated organization. Note: `connectors` is **not** the standard `{ object: "list", data, has_more, next_cursor }` envelope: an organization connects a handful of projects and they are returned whole next to `metrics_available`.',
	examples: [
		wireExample({ object: "gcp_integration", metrics_available: true, connectors: [connectorExample] }),
	],
})
export type V2GcpIntegration = Schema.Schema.Type<typeof V2GcpIntegration>

export const V2GcpCreateConnectorRequest = Schema.Struct({
	project_id: GcpProjectId.annotate({
		description:
			"The Google Cloud project ID (not its name or number): 6 to 30 lowercase letters, digits and hyphens, starting with a letter.",
	}),
}).annotate({
	identifier: "GcpCreateConnectorRequest",
	title: "Google Cloud connector create request",
	description: "The project to connect. Connect several projects by creating one connector each.",
	examples: [wireExample({ project_id: "acme-prod" })],
})
export type V2GcpCreateConnectorRequest = Schema.Schema.Type<typeof V2GcpCreateConnectorRequest>

export const V2GcpSetupScriptsRequest = Schema.Struct({
	exclude_gke_container_logs: Schema.optionalKey(Schema.Boolean).annotate({
		description:
			"Leave GKE container logs out of the log filter. Set it when the project's pods already ship their logs to Maple through an OpenTelemetry collector, so they are not ingested twice. Defaults to `false`.",
		examples: [false],
	}),
}).annotate({
	identifier: "GcpSetupScriptsRequest",
	title: "Google Cloud setup scripts request",
	description: "Options for rendering a connector's scripts.",
	examples: [wireExample({ exclude_gke_container_logs: true })],
})
export type V2GcpSetupScriptsRequest = Schema.Schema.Type<typeof V2GcpSetupScriptsRequest>

export const V2GcpSetupScripts = Schema.Struct({
	object: Schema.Literal("gcp_connector.setup_scripts").annotate({
		description: 'The object type — always `"gcp_connector.setup_scripts"`.',
	}),
	setup_script: Schema.String.annotate({
		description:
			"A bash script for Cloud Shell, run by a project owner. It embeds the connector's push secret, so treat it as a credential. Safe to re-run; the log filter is an editable variable at the top.",
		examples: ["#!/usr/bin/env bash\n…"],
	}),
	cleanup_script: Schema.String.annotate({
		description: "A bash script that removes everything the setup script created. Carries no secret.",
		examples: ["#!/usr/bin/env bash\n…"],
	}),
}).annotate({
	identifier: "GcpSetupScripts",
	title: "Google Cloud setup scripts",
	description: "The scripts that connect and disconnect one Google Cloud project.",
	examples: [
		wireExample({
			object: "gcp_connector.setup_scripts",
			setup_script: "#!/usr/bin/env bash\n…",
			cleanup_script: "#!/usr/bin/env bash\n…",
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
			"A bash script that removes the resources the setup script created. Maple has no write access to the project, so the project owner runs it.",
		examples: ["#!/usr/bin/env bash\n…"],
	}),
}).annotate({
	identifier: "GcpConnectorDeleteResponse",
	title: "Google Cloud connector delete response",
	description: "Confirmation that a connector was deleted, with the script that cleans up the project.",
	examples: [
		wireExample({
			id: connectorExample.id,
			object: "gcp_connector",
			deleted: true,
			cleanup_script: "#!/usr/bin/env bash\n…",
		}),
	],
})
export type V2GcpConnectorDeleteResponse = Schema.Schema.Type<typeof V2GcpConnectorDeleteResponse>

const [projectAlreadyConnected, connectorNotFound, integrationPersistence] = publicErrors(
	GcpProjectAlreadyConnectedError,
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
					"Returns the organization's connected Google Cloud projects with the time and outcome of their latest log push, and whether metrics collection is available. Requires the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("createConnector", "/connectors", {
			payload: V2GcpCreateConnectorRequest,
			success: V2GcpConnector,
			error: [V2InsufficientPermissions.schema, projectAlreadyConnected, integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createGcpConnector",
				summary: "Connect a Google Cloud project",
				description:
					"Registers a connector for one Google Cloud project. Nothing reaches Maple until the project owner runs the script from `setup_scripts`. A project can be connected once per organization. Requires an org-admin role and the `integrations:write` scope.",
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
					"Returns the `gcloud` scripts for one connector. Rendering changes nothing, but the setup script carries the connector's push secret, so this requires an org-admin role and the `integrations:write` scope.",
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
				summary: "Disconnect a Google Cloud project",
				description:
					"Deletes the connector, after which Maple rejects the project's log pushes. Already-ingested data is unaffected. The response carries the cleanup script to run in the project. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.prefix("/v2/integrations/gcp")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Google Cloud Integration",
			description:
				"Connect Google Cloud projects to your organization: register a connector per project, fetch the `gcloud` scripts that route its logs to Maple, and see whether logs are arriving.",
		}),
	) {}
