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
	IntegrationsUpstreamError,
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
			"Whether log forwarding is set up in Google Cloud, as the latest setup script run reported it. `null` until a run reports. The setup script has to run while `logs_enabled` is `true` and this is not, or `logs_enabled` is `false` and this is `true`.",
		examples: [true],
	}),
	applied_metrics_enabled: Schema.NullOr(Schema.Boolean).annotate({
		description:
			"Whether metrics and resource access is set up in Google Cloud, as the latest setup script run reported it. `null` until a run reports. The setup script has to run while `metrics_enabled` is `true` and this is not, or `metrics_enabled` is `false` and this is `true`.",
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

const MANUAL_EXAMPLE = {
	scope_type: "project",
	scope_id: "acme-prod",
	project_id: "acme-prod",
	apis: [
		"cloudresourcemanager.googleapis.com",
		"iam.googleapis.com",
		"logging.googleapis.com",
		"pubsub.googleapis.com",
	],
	logs: {
		topic: "maple-018f2b3c4d5e4f708192a3b4",
		subscription: "maple-018f2b3c4d5e4f708192a3b4",
		sink: "maple-018f2b3c4d5e4f708192a3b4",
		sink_destination: "pubsub.googleapis.com/projects/acme-prod/topics/maple-018f2b3c4d5e4f708192a3b4",
		log_filter: 'NOT log_id("cloudaudit.googleapis.com/data_access") AND …',
		include_children: false,
		push_endpoint: "https://ingest.maple.dev/v1/logpush/gcp/018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
		push_service_account_id: "maple-push-018f2b3c4d5e4f70819",
		push_service_account_email: "maple-push-018f2b3c4d5e4f70819@acme-prod.iam.gserviceaccount.com",
		ack_deadline_seconds: 30,
		message_retention_seconds: 86400,
		min_retry_delay_seconds: 10,
		max_retry_delay_seconds: 600,
	},
	reader: null,
} as const
const TERRAFORM_EXAMPLE =
	'# Maple connection for Google Cloud project acme-prod\n…\nresource "google_pubsub_topic" "maple" {\n  …\n}\n'
const ALCHEMY_EXAMPLE =
	'// Maple connection for Google Cloud project acme-prod\nimport * as Alchemy from "alchemy"\n…\n'

const nameField = (description: string) => Schema.String.annotate({ description })

export const V2GcpManualSetup = Schema.Struct({
	scope_type: GcpScopeType,
	scope_id: Schema.String.annotate({
		description: "The project ID, or the numeric folder or organization ID.",
	}),
	project_id: Schema.String.annotate({
		description: "The host project, which holds the topic, the subscription and the service accounts.",
	}),
	apis: Schema.Array(Schema.String).annotate({
		description: "The APIs to switch on in the host project, by service name.",
	}),
	logs: Schema.NullOr(
		Schema.Struct({
			topic: nameField("The Pub/Sub topic in the host project."),
			subscription: nameField("The push subscription on the topic."),
			sink: nameField("The Log Router sink on the scope."),
			sink_destination: nameField("The sink's destination: the topic, as Cloud Logging names it."),
			log_filter: nameField(
				"The sink's inclusion filter: what the setup script sets for the same `application_logs`. Omitted `application_logs` gives the filter a new sink gets.",
			),
			include_children: Schema.Boolean.annotate({
				description:
					"Whether the sink also routes the logs of every project under the folder or organization.",
			}),
			push_endpoint: nameField(
				"The subscription's push endpoint, which is also the audience of its push tokens. It carries no secret.",
			),
			push_service_account_id: nameField("The service account the subscription signs its pushes as."),
			push_service_account_email: nameField(
				"Its email. Maple accepts a push only when it is signed as this account.",
			),
			ack_deadline_seconds: Schema.Number.annotate({
				description: "The subscription's acknowledgement deadline.",
			}),
			message_retention_seconds: Schema.Number.annotate({
				description:
					"How long the subscription keeps unacknowledged messages. It never expires while idle.",
			}),
			min_retry_delay_seconds: Schema.Number.annotate({
				description: "The shortest wait of the exponential backoff retry policy.",
			}),
			max_retry_delay_seconds: Schema.Number.annotate({
				description: "The longest wait of the exponential backoff retry policy.",
			}),
		}),
	).annotate({ description: "Log forwarding, or `null` while `logs_enabled` is `false`." }),
	reader: Schema.NullOr(
		Schema.Struct({
			service_account_id: nameField("The read-only service account in the host project."),
			service_account_email: nameField("Its email."),
			maple_service_account_email: nameField(
				"Maple's own service account, which gets Service Account Token Creator on the read-only account.",
			),
			scope_roles: Schema.Array(Schema.String).annotate({
				description: "The roles the read-only account gets on the scope.",
			}),
			project_roles: Schema.Array(Schema.String).annotate({
				description: "The roles it gets on the host project, which its reads are billed to.",
			}),
		}),
	).annotate({
		description:
			"Read-only access for metrics and resources, or `null` while `metrics_enabled` is `false` or the deployment has no Google identity.",
	}),
}).annotate({
	identifier: "GcpManualSetup",
	title: "Google Cloud setup without the script",
	description:
		"What a console or infrastructure-as-code setup creates. Names match the setup script's, but the push subscription signs its pushes as a push service account instead of carrying a secret.",
	examples: [wireExample(MANUAL_EXAMPLE)],
})
export type V2GcpManualSetup = Schema.Schema.Type<typeof V2GcpManualSetup>

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
	manual: V2GcpManualSetup,
	terraform: Schema.String.annotate({
		description:
			"`manual` as a self-contained Terraform file for the `google` provider: every resource inline, IAM grants additive. `terraform destroy` removes what it created. It holds no secret.",
		examples: [TERRAFORM_EXAMPLE],
	}),
	alchemy: Schema.NullOr(Schema.String).annotate({
		description:
			"`manual` as a self-contained Alchemy stack (`alchemy/GCP`). It holds no secret. `null` for a folder or organization with read-only access: Alchemy can't grant roles on a folder or organization.",
		examples: [ALCHEMY_EXAMPLE],
	}),
}).annotate({
	identifier: "GcpSetupScripts",
	title: "Google Cloud setup scripts",
	description:
		"The ways to connect one Google Cloud project, folder or organization: the setup and cleanup scripts, or the same resources set up by hand or as code. Without a script nothing reports to Maple: log forwarding shows as set up once the first signed push arrives, and `check_access` confirms the read-only access.",
	examples: [
		wireExample({
			object: "gcp_connector.setup_scripts",
			setup_script: SCRIPT_EXAMPLE,
			cleanup_script: SCRIPT_EXAMPLE,
			manual: MANUAL_EXAMPLE,
			terraform: TERRAFORM_EXAMPLE,
			alchemy: ALCHEMY_EXAMPLE,
		}),
	],
})
export type V2GcpSetupScripts = Schema.Schema.Type<typeof V2GcpSetupScripts>

/** The steps of a setup without the script, in the order they are done. */
export const V2GcpSetupStep = Schema.Literals([
	"apis",
	"topic",
	"push_account",
	"subscription",
	"sink",
	"sink_grants",
	"test_message",
	"reader_account",
	"reader_roles",
	"reader_token_creator",
]).annotate({
	description: "A step of setting a connection up in the Google Cloud console, or of removing it.",
})
export type V2GcpSetupStep = Schema.Schema.Type<typeof V2GcpSetupStep>

export const V2GcpAccessCheck = Schema.Struct({
	object: Schema.Literal("gcp_connector.access_check").annotate({
		description: 'The object type — always `"gcp_connector.access_check"`.',
	}),
	ok: Schema.Boolean.annotate({
		description:
			"Whether Google Cloud matches the connector: its read-only account works while `metrics_enabled` is `true`, and is gone once it is `false`. What passed is recorded as a setup script's report would be.",
	}),
	message: Schema.NullOr(Schema.String).annotate({
		description: "Why the check failed and what to do about it. `null` when `ok` is `true`.",
	}),
	failed_step: Schema.NullOr(V2GcpSetupStep).annotate({
		description: "The step of a console setup or removal that the failure points at, or `null`.",
	}),
}).annotate({
	identifier: "GcpAccessCheck",
	title: "Google Cloud access check",
	description: "The outcome of Maple checking a connector set up or changed without the script.",
	examples: [
		wireExample({ object: "gcp_connector.access_check", ok: true, message: null, failed_step: null }),
	],
})
export type V2GcpAccessCheck = Schema.Schema.Type<typeof V2GcpAccessCheck>

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

const [
	scopeAlreadyConnected,
	metricsUnavailable,
	validation,
	connectorNotFound,
	integrationPersistence,
	integrationUpstream,
] = publicErrors(
	GcpScopeAlreadyConnectedError,
	GcpMetricsUnavailableError,
	IntegrationsValidationError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
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
					"Returns the `gcloud` scripts for one connector, and the same setup for the Google Cloud console, Terraform and Alchemy. Rendering changes nothing, but both scripts carry the connector's push secret, so this requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("checkAccess", "/connectors/:id/check_access", {
			params: { id: GcpConnectorPublicId },
			success: V2GcpAccessCheck,
			error: [
				V2InsufficientPermissions.schema,
				connectorNotFound,
				metricsUnavailable,
				integrationUpstream,
				integrationPersistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "checkGcpConnectorAccess",
				summary: "Check a connector set up without the script",
				description:
					"For a setup in the console or as code, which sends Maple no report. While `metrics_enabled` is `true`, signs in as the connector's read-only service account and lists one page of the scope's projects; once it is `false`, confirms that Maple can no longer sign in as that account. A pass is recorded in `applied_metrics_enabled`. With `logs_enabled` off, records the log sink as removed, as reported by the caller. Requires an org-admin role and the `integrations:write` scope.",
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
