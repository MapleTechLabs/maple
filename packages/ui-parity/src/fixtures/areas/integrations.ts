import { parseWarehouseDateTime } from "@maple/query-engine"
import { Effect, Predicate } from "effect"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import type { FixtureArea } from "../areas.ts"
import type { EndpointHandler, EndpointRequest } from "../dataset.ts"
import { acmeAdmin, DAY, fixtureUuid, MINUTE } from "../identity.ts"

/**
 * The /integrations hub's Postgres-backed reads, canned: Acme scrapes two Prometheus targets (one
 * failing), links a Slack workspace and has Hazel connected. Every other org has none of them.
 */

/** Only Acme (self-hosted `default` or Clerk `settings-clerk`) has integrations configured. */
export const isAcme = (request: EndpointRequest): boolean => request.dataset.identity?.orgId === acmeAdmin.orgId

const iso = (request: EndpointRequest, agoMs: number) => new Date(parseWarehouseDateTime(request.dataset.now) - agoMs).toISOString()

/** Acme's Slack connector carries the linked user's identity; other orgs' has none. */
const withSlackIdentity = <A extends object>(request: EndpointRequest, connector: A) =>
	isAcme(request)
		? { ...connector, identity: { external_user_id: "U02ADALOVE", display_name: "ada", created_at: iso(request, 20 * DAY) } }
		: connector

const list = (data: ReadonlyArray<unknown>) => ({ object: "list", data, has_more: false, next_cursor: null })

const scrapeTarget = (
	request: EndpointRequest,
	index: number,
	fields: { readonly name: string; readonly service: string; readonly url: string; readonly error: string | null },
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
			: { connected: false, externalUserId: null, externalUserEmail: null, connectedByUserId: null, scope: null },
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

export const fixtureArea: FixtureArea = {
	area: "integrations",
	endpoints: () => ({
		"scrapeTargets.list": (request) => Effect.succeed(list(scrapeTargetsOf(request))),
		"scrapeTargets.listChecks": checks,
		"chatIntegration.connectors": connectors,
		"integrations.hazelStatus": hazelStatus,
	}),
}
