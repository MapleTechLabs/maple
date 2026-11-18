/**
 * Every secret column sealed with `SecretBox`, in one place.
 *
 * A slot's `binding` must be known before the row is written and must not change for the life
 * of the row. Tables written with `ON CONFLICT DO UPDATE` keep their original `id`, so those
 * bind to the conflict target (org, provider, ...) instead of the id.
 *
 * A slot whose value Maple sends somewhere also names that `destination`, the host it goes to.
 * Derive it from stored columns only, the same way forever: a change stops old values opening.
 */
import { secretDestination, type DataSourceConfig } from "@maple/domain/data-sources"
import type { UptimeMonitorConfig } from "@maple/domain/uptime"
import { Array as Arr } from "effect"
import type { SecretSlot } from "./SecretBox"

interface OrgRef {
	readonly orgId: string
}

interface OrgRowRef extends OrgRef {
	readonly id: string
}

const orgBinding = (ref: OrgRef) => [ref.orgId]
const orgRowBinding = (ref: OrgRowRef) => [ref.orgId, ref.id]

/** Scheme, host and port; the raw text when it is not a URL (a typo, a `{{variable}}`). */
const urlHost = (raw: string): string => {
	const url = URL.canParse(raw) ? new URL(raw) : null
	return url === null ? raw : `${url.protocol}//${url.host}`
}

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

export interface ExternalDataSourceSecretRef extends OrgRowRef {
	readonly config: DataSourceConfig
}

export const externalDataSourceSecretSlot: SecretSlot<ExternalDataSourceSecretRef> = {
	name: "external_data_sources.secret",
	binding: orgRowBinding,
	destination: (ref) => [secretDestination(ref.config)],
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

export interface ClickHousePasswordRef extends OrgRef {
	readonly chUrl: string
}

/** The ingest gateway opens this one too, so the destination is `ch_url` exactly as stored. */
export const clickHousePasswordSlot: SecretSlot<ClickHousePasswordRef> = {
	name: "org_clickhouse_settings.ch_password",
	binding: orgBinding,
	destination: (ref) => [ref.chUrl],
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

export interface CostConnectionRef extends OrgRef {
	readonly provider: string
}

/** A pasted credential one provider's spend is read with; the table is one row per org and provider. */
export const costConnectionSecretSlot: SecretSlot<CostConnectionRef> = {
	name: "cost_connections.secret",
	binding: (ref) => [ref.orgId, ref.provider],
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

export interface ScrapeTargetCredentialsRef extends OrgRowRef {
	readonly url: string
}

export const scrapeTargetCredentialsSlot: SecretSlot<ScrapeTargetCredentialsRef> = {
	name: "scrape_targets.auth_credentials",
	binding: orgRowBinding,
	destination: (ref) => [urlHost(ref.url)],
}

export interface UptimeMonitorHeadersRef extends OrgRowRef {
	readonly config: UptimeMonitorConfig
}

/**
 * Where a check sends its headers. An HTTP check: its host. A multi-step check: every step's
 * whole URL and what it extracts, since a later step's host can be a variable an earlier step
 * filled from its response.
 */
const uptimeDestination = (config: UptimeMonitorConfig): ReadonlyArray<string> => {
	switch (config._tag) {
		case "http":
			return [urlHost(config.url)]
		case "multistep":
			return Arr.flatMap(config.steps, (step) => [
				step.url,
				String(step.extract.length),
				...Arr.flatMap(step.extract, (extraction) => [
					extraction.name,
					extraction.from._tag,
					extraction.from._tag === "json_path" ? extraction.from.path : extraction.from.name,
				]),
			])
		default:
			return []
	}
}

/** An HTTP or multi-step check's request headers and bodies, as one JSON document. */
export const uptimeMonitorHeadersSlot: SecretSlot<UptimeMonitorHeadersRef> = {
	name: "uptime_monitors.headers",
	binding: orgRowBinding,
	destination: (ref) => uptimeDestination(ref.config),
}
