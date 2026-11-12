/**
 * Every secret column sealed with `SecretBox`, in one place.
 *
 * A slot's `binding` must be known before the row is written and must not change for the life
 * of the row. Tables written with `ON CONFLICT DO UPDATE` keep their original `id`, so those
 * bind to the conflict target (org, provider, ...) instead of the id.
 */
import type { SecretSlot } from "./SecretBox"

interface OrgRef {
	readonly orgId: string
}

interface OrgRowRef extends OrgRef {
	readonly id: string
}

const orgBinding = (ref: OrgRef) => [ref.orgId]
const orgRowBinding = (ref: OrgRowRef) => [ref.orgId, ref.id]

export const alertDestinationSecretSlot: SecretSlot<OrgRowRef> = {
	name: "alert_destinations.secret",
	binding: orgRowBinding,
}

export const awsStreamSecretSlot: SecretSlot<OrgRowRef> = {
	name: "aws_connections.stream_secret",
	binding: orgRowBinding,
}

export interface ChatWorkspaceCredentialsRef extends OrgRef {
	readonly connector: string
	readonly externalWorkspaceId: string
}

export const chatWorkspaceCredentialsSlot: SecretSlot<ChatWorkspaceCredentialsRef> = {
	name: "chat_workspaces.credentials",
	binding: (ref) => [ref.orgId, ref.connector, ref.externalWorkspaceId],
}

/** The row has no org until it is approved; its primary key is what the CLI polls with. */
export const cliDeviceTokenSlot: SecretSlot<{ readonly deviceCodeHash: string }> = {
	name: "cli_device_authorizations.token",
	binding: (ref) => [ref.deviceCodeHash],
}

export const dashboardShareTokenSlot: SecretSlot<OrgRowRef> = {
	name: "dashboard_shares.token",
	binding: orgRowBinding,
}

export const externalDataSourceSecretSlot: SecretSlot<OrgRowRef> = {
	name: "external_data_sources.secret",
	binding: orgRowBinding,
}

export const gcpConnectorSecretSlot: SecretSlot<OrgRowRef> = {
	name: "gcp_connectors.secret",
	binding: orgRowBinding,
}

export interface OAuthConnectionRef extends OrgRef {
	readonly provider: string
}

const oauthBinding = (ref: OAuthConnectionRef) => [ref.orgId, ref.provider]

export const oauthAccessTokenSlot: SecretSlot<OAuthConnectionRef> = {
	name: "oauth_connections.access_token",
	binding: oauthBinding,
}

export const oauthRefreshTokenSlot: SecretSlot<OAuthConnectionRef> = {
	name: "oauth_connections.refresh_token",
	binding: oauthBinding,
}

export const clickHousePasswordSlot: SecretSlot<OrgRef> = {
	name: "org_clickhouse_settings.ch_password",
	binding: orgBinding,
}

export const ingestPrivateKeySlot: SecretSlot<OrgRef> = {
	name: "org_ingest_keys.private_key",
	binding: orgBinding,
}

export const openRouterKeySlot: SecretSlot<OrgRef> = {
	name: "org_openrouter_keys.key",
	binding: orgBinding,
}

/** The management key an org's OpenRouter spend is read with; the table is one row per org. */
export const openRouterCostKeySlot: SecretSlot<OrgRef> = {
	name: "openrouter_cost_connections.key",
	binding: orgBinding,
}

export const planetScaleWebhookSecretSlot: SecretSlot<OrgRowRef> = {
	name: "planetscale_connections.webhook_secret",
	binding: orgRowBinding,
}

/** The signing secret PlanetScale returns for one database's registered webhook. */
export const planetScaleDatabaseWebhookSecretSlot: SecretSlot<OrgRowRef> = {
	name: "planetscale_databases.webhook_secret",
	binding: orgRowBinding,
}

export const railwayTokenSlot: SecretSlot<OrgRef> = {
	name: "railway_connections.token",
	binding: orgBinding,
}

export const vercelTokenSlot: SecretSlot<OrgRef> = {
	name: "vercel_connections.token",
	binding: orgBinding,
}

export const scrapeTargetCredentialsSlot: SecretSlot<OrgRowRef> = {
	name: "scrape_targets.auth_credentials",
	binding: orgRowBinding,
}

/** An HTTP check's request headers, as one JSON object. */
export const uptimeMonitorHeadersSlot: SecretSlot<OrgRowRef> = {
	name: "uptime_monitors.headers",
	binding: orgRowBinding,
}
