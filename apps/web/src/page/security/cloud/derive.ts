import {
	CLOUD_FINDING_SOURCE_SPECS,
	CLOUD_SECURITY_PUSH_ALIVE_MS,
	CLOUD_FINDING_SOURCES,
	CloudAccountId,
	CloudFindingSeverity,
	CloudFindingSource,
	CloudFindingStatus,
	CloudLocation,
	CloudProvider,
	cloudFindingProvider,
} from "@maple/domain/cloud-security"
import { formatNumber } from "@maple/ui/lib/format"
import {
	type CloudFinding,
	CloudFindingDetailQuery,
	type CloudFindingsListRequest,
	type CloudSecurityConnectionModule,
	type CloudSecurityServiceStatus,
} from "@maple/domain/http"
import { Array as Arr, Option, Order, Schema, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { AppRoute, hrefOf } from "../../../route"
import type { FindingSearch, Model, Overview, Search } from "./model"

// Pure readings of the Cloud tab: the URL's filters as a request, where each cloud's setup stands,
// and the words each row shows.

const isStatus = Schema.is(CloudFindingStatus)
const isSeverity = Schema.is(CloudFindingSeverity)
const isSource = Schema.is(CloudFindingSource)
const isProvider = Schema.is(CloudProvider)
const isAccount = Schema.is(CloudAccountId)
const isRegion = Schema.is(CloudLocation)

export const PROVIDER_LABEL = {
	aws: "AWS",
	gcp: "Google Cloud",
} satisfies Record<CloudProvider, string>

/** The sources the source filter offers: the chosen cloud's, or every one. */
export const sourcesFor = (provider: string | undefined): ReadonlyArray<CloudFindingSource> =>
	isProvider(provider)
		? Arr.filter(CLOUD_FINDING_SOURCES, (source) => cloudFindingProvider(source) === provider)
		: CLOUD_FINDING_SOURCES

/** The clouds the org has connected, in a fixed order. */
export const providersOf = (overview: Overview): ReadonlyArray<CloudProvider> =>
	Arr.filter(CloudProvider.literals, (provider) =>
		Arr.some(overview.connections, (connection) => connection.provider === provider),
	)

export const SEVERITY_LABEL = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	info: "Info",
} satisfies Record<CloudFindingSeverity, string>

export const STATUS_LABEL = {
	active: "Active",
	archived: "Archived",
	resolved: "Resolved",
} satisfies Record<CloudFindingStatus, string>

export const sourceTitle = (source: CloudFindingSource): string => CLOUD_FINDING_SOURCE_SPECS[source].title

/** The longest search the API takes. */
export const SEARCH_MAX_LENGTH = 200

/** The list request the URL's filters ask for; a value that names nothing is dropped. */
export const listRequestOf = (search: Search): CloudFindingsListRequest => {
	// A longer search is cut to what the API takes, never dropped: the box still shows it as applied.
	const q = Str.slice(0, SEARCH_MAX_LENGTH)(Str.trim(search.q ?? ""))
	return {
		...(isStatus(search.status) ? { status: search.status } : undefined),
		...(isSeverity(search.severity) ? { severities: [search.severity] } : undefined),
		...(isProvider(search.provider) ? { providers: [search.provider] } : undefined),
		...(isSource(search.source) ? { sources: [search.source] } : undefined),
		...(isAccount(search.account) ? { accountId: search.account } : undefined),
		...(isRegion(search.region) ? { region: search.region } : undefined),
		...(q !== "" ? { search: q } : undefined),
	}
}

const decodeDetailQuery = Schema.decodeUnknownOption(CloudFindingDetailQuery)

/** The finding the URL names, or null when it names none. */
export const detailQueryOf = (search: FindingSearch): CloudFindingDetailQuery | null =>
	Option.getOrNull(
		decodeDetailQuery({
			connectionId: search.connection,
			region: search.region,
			source: search.source,
			findingId: search.id,
		}),
	)

export const findingHref = (finding: CloudFinding): string =>
	hrefOf(
		AppRoute.SecurityCloudFinding({
			search: {
				connection: finding.connectionId,
				region: finding.region,
				source: finding.source,
				id: finding.findingId,
			},
		}),
	)

export const listHref = (search: Search = {}): string => hrefOf(AppRoute.SecurityCloud({ search }))

export const isFiltered = (search: Search): boolean =>
	search.status !== undefined ||
	search.severity !== undefined ||
	search.provider !== undefined ||
	search.source !== undefined ||
	search.account !== undefined ||
	search.region !== undefined ||
	search.q !== undefined

/**
 * Where one cloud's security collection stands across its connections. `NotRequested`: none asks
 * for it. `AwaitingGrant`: one asks, but no deployed stack (AWS) or setup run (Google Cloud) grants
 * it yet. `Ready`: one grants it.
 */
export type ProviderSetup = "NotRequested" | "AwaitingGrant" | "Ready"

/** Each connected cloud's setup; a cloud that is not connected is absent. */
export type Setup = Readonly<Partial<Record<CloudProvider, ProviderSetup>>>

const providerSetupOf = (modules: ReadonlyArray<CloudSecurityConnectionModule>): ProviderSetup =>
	Arr.contains(modules, "granted")
		? "Ready"
		: Arr.contains(modules, "requested")
			? "AwaitingGrant"
			: "NotRequested"

export const setupOf = (overview: Overview): Setup => {
	const of = (provider: CloudProvider) => {
		const modules = Arr.map(
			Arr.filter(overview.connections, (connection) => connection.provider === provider),
			(connection) => connection.module,
		)
		return modules.length === 0 ? {} : { [provider]: providerSetupOf(modules) }
	}
	return { ...of("aws"), ...of("gcp") }
}

/** Whether any cloud's findings can be listed. */
export const isReady = (setup: Setup): boolean => setup.aws === "Ready" || setup.gcp === "Ready"

/**
 * One service in one state across places: the empty state's sentence for it. The places are AWS
 * regions, or for Security Command Center the scopes (projects, folders, organizations) it covers.
 */
export interface ServiceNotice {
	readonly provider: CloudProvider
	readonly source: CloudFindingSource
	readonly state: "not_enabled" | "denied" | "failing"
	readonly places: ReadonlyArray<string>
	/** The newest error the service reported, for `denied` and `failing`. */
	readonly lastError: string | null
}

const NOTICE_ORDER = { failing: 0, denied: 1, not_enabled: 2 } as const

/** Services that are off, refused or failing somewhere, worst first. Enabled ones say nothing. */
export const serviceNoticesOf = (overview: Overview): ReadonlyArray<ServiceNotice> => {
	const newestFirst = Arr.sort(
		overview.services,
		Order.mapInput(Order.flip(Order.Number), (service: CloudSecurityServiceStatus) => service.checkedAt),
	)
	const groups = Arr.reduce(newestFirst, new Map<string, ServiceNotice>(), (acc, service) => {
		if (service.state === "enabled") return acc
		const key = `${service.state}:${service.source}`
		const seen = acc.get(key)
		// Security Command Center answers once per scope, at `global`: the scope is the place.
		const place = service.provider === "gcp" ? service.accountId : service.region
		return acc.set(key, {
			provider: service.provider,
			source: service.source,
			state: service.state,
			places: Arr.sort(Arr.dedupe([...(seen?.places ?? []), place]), Order.String),
			lastError: seen?.lastError ?? service.lastError,
		})
	})
	return Arr.sort(
		[...groups.values()],
		Order.combine(
			Order.mapInput(Order.Number, (notice: ServiceNotice) => NOTICE_ORDER[notice.state]),
			Order.mapInput(Order.String, (notice: ServiceNotice) => notice.source),
		),
	)
}

/**
 * Which enabled services' findings arrive as events (EventBridge or Pub/Sub, from the setup), within
 * the poller's window, and the clouds the enabled services are in. Null before any service is read.
 */
export const deliveryOf = (
	overview: Overview,
	nowMs: number,
): {
	readonly live: ReadonlyArray<CloudFindingSource>
	readonly allLive: boolean
	readonly providers: ReadonlyArray<CloudProvider>
} | null => {
	const enabled = Arr.filter(overview.services, (service) => service.state === "enabled")
	if (enabled.length === 0) return null
	const providers = Arr.filter(CloudProvider.literals, (provider) =>
		Arr.some(enabled, (service) => service.provider === provider),
	)
	const sourcesOf = (services: typeof enabled) =>
		Arr.sort(Arr.dedupe(Arr.map(services, (service) => service.source)), Order.String)
	// The poller's own window: a feed whose events stopped is polled every five minutes again.
	const live = sourcesOf(
		Arr.filter(
			enabled,
			(service) =>
				service.pushedAt !== null && nowMs - service.pushedAt <= CLOUD_SECURITY_PUSH_ALIVE_MS,
		),
	)
	return { live, allLive: live.length === sourcesOf(enabled).length, providers }
}

/** The accounts and locations the filters offer: every connected account or scope, every place polled. */
export const accountsOf = (overview: Overview): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(Arr.map(overview.connections, (connection) => connection.accountId)), Order.String)

export const regionsOf = (overview: Overview): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(Arr.map(overview.services, (service) => service.region)), Order.String)

export const overviewOf = (model: Pick<Model, "overview">): Overview | null =>
	Option.getOrNull(AsyncData.getData(model.overview.data))

/** A finding's identity: the store's key past the org. */
const findingKeyOf = (finding: CloudFinding) =>
	`${finding.connectionId}\n${finding.region}\n${finding.source}\n${finding.findingId}`

/**
 * Every finding loaded so far, each once; null until the first page answers. A finding seen again
 * between two page loads moves up the order, so a later page can repeat it.
 */
export const findingsOf = (
	model: Pick<Model, "firstPage" | "laterPages">,
): ReadonlyArray<CloudFinding> | null =>
	AsyncData.matchData(model.firstPage.data, {
		onEmpty: () => null,
		onFailure: () => null,
		onData: (first) =>
			Arr.dedupeWith(
				[...first.findings, ...Arr.flatMap(model.laterPages.pages, (page) => page.findings)],
				(a, b) => findingKeyOf(a) === findingKeyOf(b),
			),
	})

/** The offset after everything loaded so far, or null at the end of the list. */
export const nextOffsetOf = (model: Pick<Model, "firstPage" | "laterPages">): number | null =>
	Option.match(Arr.last(model.laterPages.pages), {
		onNone: () =>
			AsyncData.matchData(model.firstPage.data, {
				onEmpty: () => null,
				onFailure: () => null,
				onData: (page) => page.nextOffset,
			}),
		onSome: (page) => page.nextOffset,
	})

/** Whether the telemetry match answered for every page loaded. */
export const isTelemetryMatched = (model: Pick<Model, "firstPage" | "laterPages">): boolean =>
	AsyncData.matchData(model.firstPage.data, {
		onEmpty: () => true,
		onFailure: () => true,
		onData: (first) =>
			first.telemetryMatched && Arr.every(model.laterPages.pages, (page) => page.telemetryMatched),
	})

export const requestsLabel = (requests: number): string =>
	`${formatNumber(Math.round(requests))} ${Math.round(requests) === 1 ? "request" : "requests"}`

/** "checkout-api, 1.2K requests" or "checkout-api and 2 more, 1.3K requests"; null when none. */
export const affectedSummary = (finding: CloudFinding): string | null => {
	const [first, ...rest] = finding.affectedServices
	if (first === undefined) return null
	const total = Arr.reduce(finding.affectedServices, 0, (sum, service) => sum + service.requests)
	const names = rest.length === 0 ? first.service : `${first.service} and ${rest.length} more`
	return `${names}, ${requestsLabel(total)}`
}

/** The resource as a person reads it: its name when the service gave one, else its id. */
export const resourceLabel = (finding: CloudFinding): string => finding.resourceName ?? finding.resourceId
