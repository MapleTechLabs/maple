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
	/** Gates cloud cost: the cost reads and the AWS connection's `cost` module. */
	cloudCost: DisabledByDefaultFeatureFlag,
	/**
	 * Gates external data sources: the Settings tab, the v2 API, and the agent tools and prompt
	 * section that read them.
	 */
	dataSources: DisabledByDefaultFeatureFlag,
	/**
	 * Gates the Releases row under Monitor. The `/releases` routes stay
	 * reachable by URL for anyone; the flag only decides who is shown the door.
	 */
	releases: DisabledByDefaultFeatureFlag,
	/** Gates the scheduled security audit API; internal-only while it is built out. */
	securityAudit: DisabledByDefaultFeatureFlag,
	/** Gates customer status pages: the nav row, the `/status-pages` routes, the API and MCP tools. */
	statusPages: DisabledByDefaultFeatureFlag,
}).pipe(
	Schema.encodeKeys({
		aiAutoTriage: "aiautotriage",
		cloudCost: "cloudcost",
		dataSources: "datasources",
		releases: "releases",
		securityAudit: "securityaudit",
		statusPages: "statuspages",
	}),
)

export type OrganizationFeatureFlags = Schema.Schema.Type<typeof OrganizationFeatureFlags>

const decodeOrganizationFeatureFlags = Schema.decodeUnknownOption(OrganizationFeatureFlags)

/** Every rollout off: the value for malformed metadata, and for the pre-load window. */
export const DISABLED_ORGANIZATION_FEATURE_FLAGS: OrganizationFeatureFlags = {
	aiAutoTriage: false,
	cloudCost: false,
	dataSources: false,
	releases: false,
	securityAudit: false,
	statusPages: false,
}

/**
 * Every rollout on, for the self-hosted build where there is no Clerk to read metadata from, as
 * the settings nav (`apps/web/src/page/settings/nav.ts`) does: a flag is a staged-rollout tool for
 * the managed product, and leaving them all off would hide the features from self-hosters forever.
 */
export const ENABLED_ORGANIZATION_FEATURE_FLAGS: OrganizationFeatureFlags = {
	aiAutoTriage: true,
	cloudCost: true,
	dataSources: true,
	releases: true,
	securityAudit: true,
	statusPages: true,
}

/** Decode Clerk metadata, falling back to every rollout disabled for non-object input. */
export function organizationFeatureFlagsFrom(metadata: unknown): OrganizationFeatureFlags {
	return Option.getOrElse(
		decodeOrganizationFeatureFlags(metadata),
		() => DISABLED_ORGANIZATION_FEATURE_FLAGS,
	)
}
