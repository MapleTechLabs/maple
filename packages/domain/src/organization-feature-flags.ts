import { Effect, Option, Schema, SchemaGetter } from "effect"

/**
 * Clerk public metadata is untrusted JSON. A rollout flag is enabled only by
 * the literal boolean `true`; missing and malformed values remain disabled.
 */
const DisabledByDefaultFeatureFlag = Schema.Unknown.pipe(
	Schema.decodeTo(Schema.Boolean, {
		decode: SchemaGetter.transform((value: unknown) => value === true),
		encode: SchemaGetter.passthrough<boolean>(),
	}),
	Schema.withDecodingDefaultKey(Effect.succeed(false)),
)

/**
 * The single contract for organization-scoped rollout flags stored in Clerk, read by the web app
 * to decide what to show and by the backend to decide what to run.
 * Decoded consumers use product-facing camelCase names; encoded keys match
 * Clerk's public metadata exactly.
 */
export const OrganizationFeatureFlags = Schema.Struct({
	aiAutoTriage: DisabledByDefaultFeatureFlag,
	/** Gates cloud security findings: the AWS connection's `security` module and the Cloud findings tab. */
	cloudSecurity: DisabledByDefaultFeatureFlag,
	/**
	 * Gates external data sources: the Settings tab, the v2 API, and the agent tools and prompt
	 * section that read them.
	 */
	dataSources: DisabledByDefaultFeatureFlag,
	/**
	 * Gates the Product analytics page: the nav row, the `/product-analytics` route and the link to
	 * it from Web analytics. Dashboard funnel and paths widgets are not gated.
	 */
	productAnalytics: DisabledByDefaultFeatureFlag,
	/**
	 * Gates continuous profiling in the dashboard: the service page's Profiles tab and the span
	 * panel's Profile tab. Off until profile ingest is live for customers.
	 */
	profiling: DisabledByDefaultFeatureFlag,
	/** Gates the scheduled security audit API; internal-only while it is built out. */
	securityAudit: DisabledByDefaultFeatureFlag,
}).pipe(
	Schema.encodeKeys({
		aiAutoTriage: "aiautotriage",
		cloudSecurity: "cloudsecurity",
		dataSources: "datasources",
		productAnalytics: "productanalytics",
		profiling: "profiling",
		securityAudit: "securityaudit",
	}),
)

export type OrganizationFeatureFlags = Schema.Schema.Type<typeof OrganizationFeatureFlags>

const decodeOrganizationFeatureFlags = Schema.decodeUnknownOption(OrganizationFeatureFlags)

/** Every rollout off: the value for malformed metadata, and for the pre-load window. */
export const DISABLED_ORGANIZATION_FEATURE_FLAGS: OrganizationFeatureFlags = {
	aiAutoTriage: false,
	cloudSecurity: false,
	dataSources: false,
	productAnalytics: false,
	profiling: false,
	securityAudit: false,
}

/**
 * Every rollout on, for the self-hosted build where there is no Clerk to read metadata from, as
 * the settings nav (`apps/web/src/page/settings/nav.ts`) does: a flag is a staged-rollout tool for
 * the managed product, and leaving them all off would hide the features from self-hosters forever.
 */
export const ENABLED_ORGANIZATION_FEATURE_FLAGS: OrganizationFeatureFlags = {
	aiAutoTriage: true,
	cloudSecurity: true,
	dataSources: true,
	productAnalytics: true,
	profiling: true,
	securityAudit: true,
}

/** Decode Clerk metadata, falling back to every rollout disabled for non-object input. */
export function organizationFeatureFlagsFrom(metadata: unknown): OrganizationFeatureFlags {
	return Option.getOrElse(
		decodeOrganizationFeatureFlags(metadata),
		() => DISABLED_ORGANIZATION_FEATURE_FLAGS,
	)
}
