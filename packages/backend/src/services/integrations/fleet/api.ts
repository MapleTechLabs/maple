/**
 * Fleet's REST API (`/api/v1/fleet/*`) on the vendor HTTP kit, read-only. The server is the
 * customer's own, so its URL is checked as an external address before every client is built and
 * the kit never follows a redirect. Failures fold into one {@link FleetApiError} whose `kind`
 * drives the poller and the connect form.
 */
import { validateExternalUrl } from "@maple/safe-fetch"
import { type Array as Arr, Duration, Effect, Redacted, Schema, String as Str } from "effect"
import type { HttpClient } from "effect/http"
import * as VendorHttp from "../vendor-http"
import { FleetActivitiesPage } from "./activities"

const REQUEST_TIMEOUT = Duration.seconds(20)
const API_PREFIX = "/api/v1/fleet"

export class FleetApiError extends Schema.TaggedError<FleetApiError>()(
	"@maple/backend/integrations/FleetApiError",
	{
		message: Schema.String,
		kind: Schema.Literals(["unauthorized", "forbidden", "rate_limited", "unreachable", "upstream"]),
		status: Schema.optionalKey(Schema.Number),
		retryAfterSeconds: Schema.optionalKey(Schema.Number),
	},
) {}

/** Fleet's error body: `{ message, errors: [{ name, reason }] }`. */
const ErrorBody = Schema.Struct({
	message: Schema.optionalKey(Schema.String),
	errors: Schema.optionalKey(
		Schema.NullOr(Schema.Array(Schema.Struct({ reason: Schema.optionalKey(Schema.String) }))),
	),
})
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody))

const detailOf = (body: string): string | undefined => {
	const parsed = decodeErrorBody(body)
	if (parsed._tag === "None") return undefined
	const reason = parsed.value.errors?.[0]?.reason
	return reason ?? parsed.value.message
}

const toFleetError = (error: VendorHttp.VendorHttpError): FleetApiError => {
	const status = error.status === undefined ? undefined : { status: error.status }
	switch (error.kind) {
		case "unauthorized":
			return new FleetApiError({
				message: "Fleet rejected the API token.",
				kind: "unauthorized",
				...status,
			})
		case "forbidden":
			return new FleetApiError({
				message: "The API token's user may not read this in Fleet.",
				kind: "forbidden",
				...status,
			})
		case "rate_limited":
			return new FleetApiError({
				message: "Fleet asked Maple to slow down.",
				kind: "rate_limited",
				...status,
				...(error.retryAfterSeconds === undefined
					? undefined
					: { retryAfterSeconds: error.retryAfterSeconds }),
			})
		case "timeout":
			return new FleetApiError({ message: "Fleet did not answer in time.", kind: "unreachable" })
		case "not_found":
			return new FleetApiError({
				// A 410 is Fleet saying it removed the endpoint; a 404 is an address that is not Fleet's.
				message:
					error.status === 410
						? `This Fleet version no longer serves a read Maple makes${error.detail === undefined ? "." : `: ${Str.slice(0, 200)(error.detail)}`}`
						: "This address does not serve the Fleet API. Use the URL you open Fleet at.",
				kind: "upstream",
				...status,
			})
		default:
			// No status: the request never got an answer (DNS, TLS, refused connection). Cloudflare
			// answers 52x/530 itself when the host does not resolve or its origin does not respond.
			return error.status === undefined || (error.status >= 520 && error.status <= 530)
				? new FleetApiError({
						message: "Maple could not reach this address. Check the Fleet URL.",
						kind: "unreachable",
					})
				: new FleetApiError({
						message: `Fleet answered ${error.status}${error.detail === undefined ? "" : `: ${Str.slice(0, 200)(error.detail)}`}`,
						kind: "upstream",
						...status,
					})
	}
}

export interface FleetCredentials {
	/** The normalized base URL ({@link normalizeFleetUrl}). */
	readonly baseUrl: string
	readonly token: Redacted.Redacted
}

/**
 * The server's base URL as stored: `https` only (the token travels with every request), no query,
 * fragment or credentials, no trailing slash, and the `/api/...` part dropped when one was pasted.
 */
export const normalizeFleetUrl = (raw: string): Effect.Effect<string, FleetApiError> =>
	Effect.gen(function* () {
		const trimmed = Str.trim(raw)
		const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
		const url = yield* validateExternalUrl(withScheme).pipe(
			Effect.mapError((error) => new FleetApiError({ message: error.message, kind: "upstream" })),
		)
		if (url.protocol !== "https:") {
			return yield* new FleetApiError({
				message: "Use an https:// address: the API token is sent with every request.",
				kind: "upstream",
			})
		}
		if (url.username !== "" || url.password !== "") {
			return yield* new FleetApiError({
				message: "Leave credentials out of the address; the API token is entered separately.",
				kind: "upstream",
			})
		}
		const path = Str.replace(/\/+$/, "")(Str.replace(/\/api(\/.*)?$/, "")(url.pathname))
		return `${url.protocol}//${url.host}${path}`
	})

const client = (httpClient: HttpClient.HttpClient, credentials: FleetCredentials) =>
	VendorHttp.make({
		httpClient,
		peerService: "fleet",
		baseUrl: `${credentials.baseUrl}${API_PREFIX}`,
		auth: VendorHttp.bearer(credentials.token),
		headers: { accept: "application/json" },
		detail: detailOf,
		toError: toFleetError,
		timeout: REQUEST_TIMEOUT,
	})

/** The client for one server; the stored URL is checked again, since the rules can tighten. */
export const fleetClient = (httpClient: HttpClient.HttpClient, credentials: FleetCredentials) =>
	validateExternalUrl(credentials.baseUrl).pipe(
		Effect.mapError((error) => new FleetApiError({ message: error.message, kind: "upstream" })),
		Effect.as(client(httpClient, credentials)),
	)

export type FleetClient = ReturnType<typeof client>

const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String))

/** `GET /me`: the token's user. A user with roles on single fleets only has a null `global_role`. */
export const FleetMe = Schema.Struct({
	user: Schema.Struct({
		id: Schema.Number,
		name: NullableString,
		email: NullableString,
		global_role: NullableString,
		api_only: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	}),
})
export type FleetMe = typeof FleetMe.Type

export const FleetVersion = Schema.Struct({ version: Schema.String })

/** `GET /config`: only the parts Maple reads; observers see these. */
export const FleetConfig = Schema.Struct({
	org_info: Schema.optionalKey(Schema.NullOr(Schema.Struct({ org_name: NullableString }))),
	license: Schema.optionalKey(Schema.NullOr(Schema.Struct({ tier: NullableString }))),
})

export const getMe = (fleet: FleetClient) =>
	fleet.json(FleetMe, { path: "/me", operation: "reading the token's user" })

export const getVersion = (fleet: FleetClient) =>
	fleet.json(FleetVersion, { path: "/version", operation: "reading the server version" })

export const getConfig = (fleet: FleetClient) =>
	fleet.json(FleetConfig, { path: "/config", operation: "reading the server settings" })

/**
 * One page of the activity feed, oldest first. `after` is the last id read (a keyset cursor on
 * `id`); without it the page starts at `since`, an ISO time.
 */
export const listActivities = (
	fleet: FleetClient,
	page: {
		readonly after?: number
		readonly since?: string
		readonly perPage: number
		/** Newest first: for a server that ignores `after`. */
		readonly newestFirst?: boolean
		/** Offset paging, with `newestFirst`. */
		readonly page?: number
	},
) =>
	fleet.json(FleetActivitiesPage, {
		path: "/activities",
		query: {
			order_key: "id",
			order_direction: page.newestFirst === true ? "desc" : "asc",
			per_page: page.perPage,
			page: page.page,
			after: page.after,
			start_created_at: page.after === undefined ? page.since : undefined,
		},
		operation: "reading the activity feed",
	})

const NullableNumber = Schema.optionalKey(Schema.NullOr(Schema.Number))
const NullableBoolean = Schema.optionalKey(Schema.NullOr(Schema.Boolean))

export const FleetPolicy = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	description: NullableString,
	resolution: NullableString,
	critical: NullableBoolean,
	platform: NullableString,
	passing_host_count: NullableNumber,
	failing_host_count: NullableNumber,
	host_count_updated_at: NullableString,
})
export type FleetPolicy = typeof FleetPolicy.Type

/** A fleet: a group of devices with its own policies. Fleet called these teams before 4.82. */
export const FleetGroup = Schema.Struct({ id: Schema.Number, name: Schema.String })
export type FleetGroup = typeof FleetGroup.Type

export const FleetHost = Schema.Struct({
	id: Schema.Number,
	hostname: NullableString,
	display_name: NullableString,
	platform: NullableString,
})
export type FleetHost = typeof FleetHost.Type

export const FleetVulnerability = Schema.Struct({
	cve: Schema.String,
	details_link: NullableString,
	cvss_score: NullableNumber,
	epss_probability: NullableNumber,
	cisa_known_exploit: NullableBoolean,
	resolved_in_version: NullableString,
})
export type FleetVulnerability = typeof FleetVulnerability.Type

export const FleetSoftwareVersion = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	version: Schema.String,
	source: NullableString,
	hosts_count: NullableNumber,
	vulnerabilities: Schema.optionalKey(Schema.NullOr(Schema.Array(FleetVulnerability))),
})
export type FleetSoftwareVersion = typeof FleetSoftwareVersion.Type

/** A CVE as Fleet counts it across devices (`GET /vulnerabilities`). Scores come with Premium. */
export const FleetCve = Schema.Struct({
	cve: Schema.String,
	details_link: NullableString,
	hosts_count: NullableNumber,
	cvss_score: NullableNumber,
	epss_probability: NullableNumber,
	cisa_known_exploit: NullableBoolean,
})
export type FleetCve = typeof FleetCve.Type

// Fleet leaves an empty list out of its JSON, so every list here may be missing.
const PoliciesPage = Schema.Struct({ policies: Schema.optionalKey(Schema.NullOr(Schema.Array(FleetPolicy))) })
/** Servers before 4.82 answer `teams`; 4.82 to 4.96 answer both keys; Fleet 5 answers `fleets`. */
const FleetGroupsPage = Schema.Struct({
	fleets: Schema.optionalKey(Schema.NullOr(Schema.Array(FleetGroup))),
	teams: Schema.optionalKey(Schema.NullOr(Schema.Array(FleetGroup))),
})
const HostsPage = Schema.Struct({ hosts: Schema.optionalKey(Schema.NullOr(Schema.Array(FleetHost))) })
const HostsCount = Schema.Struct({ count: Schema.Number })
const SoftwareVersionsPage = Schema.Struct({
	software: Schema.optionalKey(Schema.NullOr(Schema.Array(FleetSoftwareVersion))),
	meta: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ has_next_results: Schema.optionalKey(Schema.NullOr(Schema.Boolean)) })),
	),
})

const VulnerabilitiesPage = Schema.Struct({
	vulnerabilities: Schema.optionalKey(Schema.NullOr(Schema.Array(FleetCve))),
	/** Every CVE on the server's devices, past this page too. */
	count: NullableNumber,
	meta: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ has_next_results: Schema.optionalKey(Schema.NullOr(Schema.Boolean)) })),
	),
})

/** Whose policies a read asks for: every device's, one fleet's, or those of devices in no fleet. */
export type PolicyScope =
	| { readonly _tag: "Global" }
	| { readonly _tag: "Unassigned" }
	| { readonly _tag: "Fleet"; readonly id: number }

/** Fleet's id for the devices in no fleet. */
const UNASSIGNED_ID = 0

const scopeId = (scope: Exclude<PolicyScope, { readonly _tag: "Global" }>): number =>
	scope._tag === "Unassigned" ? UNASSIGNED_ID : scope.id

/**
 * Where a server version keeps its fleets and policies. Fleet 5 reads every scope from `/policies`
 * and answers 410 on the per-scope paths; Fleet 4 only has those, under `/fleets` from 4.82 and
 * `/teams` before it.
 */
export interface FleetDialect {
	readonly fleetsPath: string
	/** Whether devices in no fleet have policies of their own: from 4.57, before it fleet 0 is a 404. */
	readonly unassigned: boolean
	/** The path a scope's policies are read from, and the fleet it is asked for when the path names none. */
	readonly policies: (scope: PolicyScope) => { readonly path: string; readonly fleetId?: number }
}

const perScope = (groups: string, unassigned = true): FleetDialect => ({
	fleetsPath: groups,
	unassigned,
	policies: (scope) => ({
		path: scope._tag === "Global" ? "/global/policies" : `${groups}/${scopeId(scope)}/policies`,
	}),
})

const FLEET_5: FleetDialect = {
	fleetsPath: "/fleets",
	unassigned: true,
	policies: (scope) =>
		scope._tag === "Global" ? { path: "/policies" } : { path: "/policies", fleetId: scopeId(scope) },
}
const FLEET_4 = perScope("/fleets")
const FLEET_4_TEAMS = perScope("/teams")
const FLEET_4_TEAMS_ONLY = perScope("/teams", false)

/**
 * The dialects to try for a server version (`4.95.0`, `5.0.0-rc.1`, a build's `fleet-v4.95.0-3-gabc`),
 * in order. A version that names no release (`unknown`, a commit) gets every one, newest first.
 */
export const fleetDialectsOf = (version: string): Arr.NonEmptyReadonlyArray<FleetDialect> => {
	const [, major, minor] = /(\d+)\.(\d+)/.exec(version) ?? []
	if (major === undefined || minor === undefined || Number(major) < 4)
		return [FLEET_5, FLEET_4, FLEET_4_TEAMS, FLEET_4_TEAMS_ONLY]
	if (Number(major) >= 5) return [FLEET_5]
	if (Number(minor) >= 82) return [FLEET_4]
	return [Number(minor) >= 57 ? FLEET_4_TEAMS : FLEET_4_TEAMS_ONLY]
}

/** One page of a scope's policies with their passing and failing device counts. */
export const listPolicies = (
	fleet: FleetClient,
	dialect: FleetDialect,
	scope: PolicyScope,
	page: number,
	perPage: number,
) => {
	const { path, fleetId } = dialect.policies(scope)
	return fleet
		.json(PoliciesPage, {
			path,
			query: { fleet_id: fleetId, order_key: "id", page, per_page: perPage },
			operation: "reading policies",
		})
		.pipe(Effect.map((answer) => answer.policies ?? []))
}

/** One page of the server's fleets. Fleet Free has none and answers 402. */
export const listFleets = (fleet: FleetClient, dialect: FleetDialect, page: number, perPage: number) =>
	fleet
		.json(FleetGroupsPage, {
			path: dialect.fleetsPath,
			query: { order_key: "id", page, per_page: perPage },
			operation: "reading fleets",
		})
		.pipe(Effect.map((answer) => answer.fleets ?? answer.teams ?? []))

/** A sample of the devices failing one policy. */
export const listFailingHosts = (fleet: FleetClient, policyId: number, perPage: number) =>
	fleet.json(HostsPage, {
		path: "/hosts",
		query: { policy_id: policyId, policy_response: "failing", per_page: perPage, page: 0 },
		operation: "reading the devices failing a policy",
	})

export const countHosts = (fleet: FleetClient) =>
	fleet.json(HostsCount, { path: "/hosts/count", operation: "counting devices" })

/** One page of installed software versions with a known vulnerability, most installed first. */
export const listVulnerableSoftware = (fleet: FleetClient, page: number, perPage: number) =>
	fleet.json(SoftwareVersionsPage, {
		path: "/software/versions",
		query: {
			vulnerable: "true",
			order_key: "hosts_count",
			order_direction: "desc",
			page,
			per_page: perPage,
		},
		operation: "reading vulnerable software",
	})

/**
 * One page of CVEs, on the most devices first, each with Fleet's own device count (a device with
 * two affected packages counts once). A 404 from a server older than this endpoint.
 */
export const listVulnerabilities = (fleet: FleetClient, page: number, perPage: number) =>
	fleet.json(VulnerabilitiesPage, {
		path: "/vulnerabilities",
		query: { order_key: "hosts_count", order_direction: "desc", page, per_page: perPage },
		operation: "reading vulnerabilities",
	})
