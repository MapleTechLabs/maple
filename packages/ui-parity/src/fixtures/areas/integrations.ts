import { parseWarehouseDateTime } from "@maple/query-engine"
import { Effect, Predicate } from "effect"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import type { FixtureArea } from "../areas.ts"
import type { EndpointHandler, EndpointRequest } from "../dataset.ts"
import { acmeAdmin, DAY, fixtureUuid, MINUTE } from "../identity.ts"
import { gcpConnector, planetscaleStatus } from "./infra-integrations.ts"

/**
 * The /integrations hub's Postgres-backed reads, canned: Acme scrapes two Prometheus targets (one
 * failing), links a Slack workspace and has Hazel connected. Every other org has none of them.
 */

/** Only Acme (self-hosted `default` or Clerk `settings-clerk`) has integrations configured. */
export const isAcme = (request: EndpointRequest): boolean =>
	request.dataset.identity?.orgId === acmeAdmin.orgId

const iso = (request: EndpointRequest, agoMs: number) =>
	new Date(parseWarehouseDateTime(request.dataset.now) - agoMs).toISOString()

/** Acme's Slack connector carries the linked user's identity; other orgs' has none. */
const withSlackIdentity = <A extends object>(request: EndpointRequest, connector: A) =>
	isAcme(request)
		? {
				...connector,
				identity: {
					external_user_id: "U02ADALOVE",
					display_name: "ada",
					created_at: iso(request, 20 * DAY),
				},
			}
		: connector

const list = (data: ReadonlyArray<unknown>) => ({ object: "list", data, has_more: false, next_cursor: null })

const scrapeTarget = (
	request: EndpointRequest,
	index: number,
	fields: {
		readonly name: string
		readonly service: string
		readonly url: string
		readonly error: string | null
	},
) => ({
	id: encodePublicId(PublicIdPrefixes.scrapeTarget, fixtureUuid(0xd4, index)),
	object: "scrape_target",
	name: fields.name,
	service_name: fields.service,
	url: fields.url,
	target_type: "prometheus",
	organization: null,
	include_branches: [],
	exclude_branches: [],
	scrape_interval_seconds: 60,
	labels_json: null,
	auth_type: index === 2 ? "bearer" : "none",
	has_credentials: index === 2,
	managed_by: null,
	enabled: true,
	last_scrape_at: iso(request, fields.error === null ? MINUTE : 47 * MINUTE),
	last_scrape_error: fields.error,
	created_at: iso(request, (40 - index * 10) * DAY),
	updated_at: iso(request, 2 * DAY),
})

/** Newest first, as the API lists them. */
export const scrapeTargetsOf = (request: EndpointRequest) =>
	isAcme(request)
		? [
				scrapeTarget(request, 2, {
					name: "redis exporter",
					service: "cart-svc",
					url: "https://redis-exporter.shop.internal:9121/metrics",
					error: "GET /metrics: 503 Service Unavailable",
				}),
				scrapeTarget(request, 1, {
					name: "postgres exporter",
					service: "payment-svc",
					url: "https://pg-exporter.shop.internal:9187/metrics",
					error: null,
				}),
			]
		: []

const slackWorkspace = (request: EndpointRequest) => ({
	id: encodePublicId(PublicIdPrefixes.chatWorkspace, fixtureUuid(0xd5, 1)),
	object: "chat_workspace",
	connector: "slack",
	external_workspace_id: "T04ACMESHOP",
	name: "Acme Shop",
	settings: {},
	created_at: iso(request, 21 * DAY),
})

const connectors: EndpointHandler = (request) =>
	Effect.succeed({
		object: "chat_connector_list",
		data: [
			{
				id: "discord",
				object: "chat_connector",
				name: "Discord",
				available: true,
				workspaces: [],
				supports_identity: true,
			},
			withSlackIdentity(request, {
				id: "slack",
				object: "chat_connector",
				name: "Slack",
				available: true,
				workspaces: isAcme(request) ? [slackWorkspace(request)] : [],
				supports_identity: true,
			}),
		],
	})

const hazelStatus: EndpointHandler = (request) =>
	Effect.succeed(
		isAcme(request)
			? {
					connected: true,
					externalUserId: "hz_user_parity_ada",
					externalUserEmail: acmeAdmin.email,
					connectedByUserId: acmeAdmin.userId,
					scope: "openid profile email",
				}
			: {
					connected: false,
					externalUserId: null,
					externalUserEmail: null,
					connectedByUserId: null,
					scope: null,
				},
	)

/** The decoded `scrp_` id is the raw UUID. */
const FAILING_TARGET = fixtureUuid(0xd4, 2)

/** One scheduled check every 5 minutes, newest first; the redis exporter has failed for 47 minutes. */
const checks: EndpointHandler = (request) => {
	const failing = Predicate.hasProperty(request.params, "id") && request.params.id === FAILING_TARGET
	return Effect.succeed(
		list(
			Array.from({ length: 12 }, (_, index) => {
				const agoMinutes = (failing ? 47 : 1) + index * 5
				const ok = !failing || agoMinutes > 50
				return {
					object: "scrape_target.check",
					timestamp: iso(request, agoMinutes * MINUTE),
					success: ok,
					sub_target_key: null,
					duration_seconds: ok ? 0.18 + (index % 4) * 0.03 : 10,
					samples_scraped: ok ? 1840 + (index % 3) * 12 : null,
					samples_post_metric_relabeling: ok ? 1840 + (index % 3) * 12 : null,
					message: ok ? null : "GET /metrics: 503 Service Unavailable",
				}
			}),
		),
	)
}

/** An OAuth start answers an authorize URL off the fixture origin: the harness blocks the redirect. */
const startConnect =
	(provider: string): EndpointHandler =>
	() =>
		Effect.succeed({
			redirectUrl: `https://oauth.${provider}.example/authorize?state=parity`,
			state: "parity-oauth-state",
		})

const disconnected: EndpointHandler = () => Effect.succeed({ disconnected: true })

const stringField = (value: unknown, key: string): string | null =>
	Predicate.hasProperty(value, key) && typeof value[key] === "string" ? value[key] : null
const booleanField = (value: unknown, key: string): boolean | null =>
	Predicate.hasProperty(value, key) && typeof value[key] === "boolean" ? value[key] : null

/** A connection made a moment ago: nothing reported, nothing received. */
const createdGcpConnector: EndpointHandler = (request) => {
	const scopeId = stringField(request.payload, "scope_id") ?? ""
	return Effect.succeed({
		id: encodePublicId(PublicIdPrefixes.gcpConnector, fixtureUuid(40, 9)),
		object: "gcp_connector",
		scope_type: stringField(request.payload, "scope_type") ?? "project",
		scope_id: scopeId,
		project_id: stringField(request.payload, "project_id") ?? scopeId,
		logs_enabled: booleanField(request.payload, "logs_enabled") ?? true,
		metrics_enabled: booleanField(request.payload, "metrics_enabled") ?? false,
		created_at: iso(request, 0),
		last_log_received_at: null,
		last_log_error: null,
		applied_logs_enabled: null,
		applied_metrics_enabled: null,
		setup_reported_at: null,
		last_metrics_received_at: null,
		last_metrics_error: null,
		discovered_project_count: 0,
		last_resources_error: null,
	})
}

/** The connected org's one connection with the changed flags; omitted ones stay. */
const updatedGcpConnector: EndpointHandler = (request) =>
	Effect.succeed({
		...gcpConnector,
		logs_enabled: booleanField(request.payload, "logs_enabled") ?? gcpConnector.logs_enabled,
		metrics_enabled: booleanField(request.payload, "metrics_enabled") ?? gcpConnector.metrics_enabled,
	})

export const fixtureArea: FixtureArea = {
	area: "integrations",
	endpoints: () => ({
		"chatIntegration.install": () =>
			Effect.succeed({
				object: "chat_connector.install",
				url: "/integrations?integration=chat-slack&chat=connected&chat_workspace=Acme%20Ops",
			}),
		"chatIntegration.startChatIdentityLink": () =>
			Effect.succeed({
				object: "chat_connector.identity_link",
				url: "/integrations?integration=chat-slack&chat_identity=linked&chat_identity_name=ada",
			}),
		"chatIntegration.deleteChatIdentity": () =>
			Effect.succeed({ object: "chat_connector.identity", deleted: true }),
		"chatIntegration.deleteWorkspace": (request) =>
			Effect.succeed({ id: slackWorkspace(request).id, object: "chat_workspace", deleted: true }),
		"planetscaleIntegration.connect": () =>
			Effect.succeed({
				object: "planetscale_integration.connect",
				redirect_url: "https://oauth.planetscale.example/authorize?state=parity",
				state: "parity-oauth-state",
			}),
		"planetscaleIntegration.organizations": () =>
			Effect.succeed({
				object: "planetscale_integration.organization_list",
				organizations: [
					{ id: "organization/acme", name: "acme" },
					{ id: "organization/acme-labs", name: "acme-labs" },
				],
			}),
		"planetscaleIntegration.selectOrganization": () => Effect.succeed(planetscaleStatus),
		"planetscaleIntegration.setMetricsToken": () => Effect.succeed(planetscaleStatus),
		"planetscaleIntegration.disconnect": () =>
			Effect.succeed({ object: "planetscale_integration", connected: false }),
		"planetscaleIntegration.webhookConfig": () =>
			Effect.succeed({
				object: "planetscale_integration.webhook_config",
				configured: true,
				url: "https://api.maple.dev/api/integrations/planetscale/webhook/parity",
				secret: "whsec_parity_0000000000000000",
			}),
		"gcpIntegration.setupScripts": () =>
			Effect.succeed({
				object: "gcp_connector.setup_scripts",
				setup_script: "#!/usr/bin/env bash\necho 'setting up Maple'\n",
				cleanup_script: "#!/usr/bin/env bash\necho 'removing Maple'\n",
				push_endpoint: "https://ingest.maple.dev/v1/logpush/gcp/parity",
				log_filter: 'NOT log_id("cloudaudit.googleapis.com/data_access") AND NOT httpRequest.userAgent:"GoogleHC"',
				maple_service_account_email: "collector@maple-parity.iam.gserviceaccount.com",
				terraform: '# Maple connection for Google Cloud\nresource "google_pubsub_topic" "maple" {\n  name = "maple-logs"\n}\n',
				alchemy: '// Maple connection for Google Cloud\nimport alchemy from "alchemy"\nconst app = await alchemy("maple")\n',
			}),
		// The admin's word that the switched-off parts are gone: the connection as it stands.
		"gcpIntegration.confirmRemoval": () => Effect.succeed(gcpConnector),
		"gcpIntegration.createConnector": createdGcpConnector,
		"gcpIntegration.updateConnector": updatedGcpConnector,
		"gcpIntegration.deleteConnector": (request) =>
			Effect.succeed({
				// The decoded param is the internal id; the answer carries the public one.
				id: encodePublicId(
					PublicIdPrefixes.gcpConnector,
					Predicate.hasProperty(request.params, "id") && typeof request.params.id === "string"
						? request.params.id
						: fixtureUuid(40, 2),
				),
				object: "gcp_connector",
				deleted: true,
				cleanup_script: "#!/usr/bin/env bash\necho 'removing Maple'\n",
			}),
		"integrations.railwayDisconnect": disconnected,
		// The sync answers a refreshed status; the card re-reads the status itself, so its shape is all that matters.
		"integrations.railwaySync": (request) =>
			Effect.succeed({
				connected: true,
				workspaceNames: null,
				connectedByUserId: null,
				connectedAt: null,
				authFailed: false,
				lastSyncedAt: parseWarehouseDateTime(request.dataset.now),
				lastError: null,
				environments: [],
			}),
		"integrations.hazelStart": startConnect("hazel"),
		"integrations.hazelDisconnect": disconnected,
		"integrations.githubStart": startConnect("github"),
		"integrations.githubDisconnect": disconnected,
		"integrations.githubSetCiTraces": (request) =>
			Effect.succeed({
				enabled:
					Predicate.hasProperty(request.payload, "enabled") && request.payload.enabled === true,
			}),
		"integrations.githubSetTrackedBranch": (request) =>
			Effect.succeed({
				trackedBranch:
					Predicate.hasProperty(request.payload, "trackedBranch") &&
					typeof request.payload.trackedBranch === "string"
						? request.payload.trackedBranch
						: "main",
				backfillQueued: true,
			}),
		"integrations.githubDeleteRepository": () => Effect.succeed({ deleted: true }),
		"integrations.cloudflareStart": startConnect("cloudflare"),
		"integrations.cloudflareDisconnect": disconnected,
		"scrapeTargets.list": (request) => Effect.succeed(list(scrapeTargetsOf(request))),
		"scrapeTargets.listChecks": checks,
		// Writes answer with the first listed target (the store is not mutated: the list re-read is unchanged).
		"scrapeTargets.create": (request) =>
			Effect.succeed(scrapeTargetsOf(request)[1] ?? scrapeTargetsOf(request)[0]),
		"scrapeTargets.update": (request) => Effect.succeed(scrapeTargetsOf(request)[0]),
		"scrapeTargets.delete": (request) =>
			Effect.succeed({ id: scrapeTargetsOf(request)[0]?.id, object: "scrape_target", deleted: true }),
		"scrapeTargets.probe": (request) =>
			Effect.succeed({
				object: "scrape_target.probe_result",
				success: false,
				last_scrape_at: iso(request, 0),
				last_scrape_error: "GET /metrics: 503 Service Unavailable",
			}),
		"chatIntegration.connectors": connectors,
		"integrations.hazelStatus": hazelStatus,
	}),
}
