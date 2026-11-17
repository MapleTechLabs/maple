import {
	CLOUD_FINDING_SOURCE_SPECS,
	CLOUD_SECURITY_PUSH_ALIVE_MS,
	CloudFindingSeverity,
	CloudFindingSource,
	CloudFindingStatus,
} from "@maple/domain/cloud-security"
import { formatNumber } from "@maple/ui/lib/format"
import {
	type CloudFinding,
	CloudFindingDetailQuery,
	type CloudFindingsListRequest,
	type CloudSecurityServiceStatus,
} from "@maple/domain/http"
import { AwsAccountId, AwsRegion } from "@maple/primitives"
import { Array as Arr, Option, Order, Schema, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { AppRoute, hrefOf } from "../../../route"
import type { FindingSearch, Model, Overview, Search } from "./model"

// Pure readings of the Cloud tab: the URL's filters as a request, where the AWS setup stands, and
// the words each row shows.

const isStatus = Schema.is(CloudFindingStatus)
const isSeverity = Schema.is(CloudFindingSeverity)
const isSource = Schema.is(CloudFindingSource)
const isAccount = Schema.is(AwsAccountId)
const isRegion = Schema.is(AwsRegion)

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
	search.source !== undefined ||
	search.account !== undefined ||
	search.region !== undefined ||
	search.q !== undefined

/**
 * Where the org's AWS security module stands. `NoConnection`: AWS is not connected.
 * `NotRequested`: no connection asks for the module. `AwaitingGrant`: one asks, but no deployed
 * stack grants it yet. `Ready`: a role grants it.
 */
export type Setup = "NoConnection" | "NotRequested" | "AwaitingGrant" | "Ready"

export const setupOf = (overview: Overview): Setup => {
	const modules = Arr.map(overview.connections, (connection) => connection.module)
	if (modules.length === 0) return "NoConnection"
	if (Arr.contains(modules, "granted")) return "Ready"
	if (Arr.contains(modules, "requested")) return "AwaitingGrant"
	return "NotRequested"
}

/** One service in one state across regions: the empty state's sentence for it. */
export interface ServiceNotice {
	readonly source: CloudFindingSource
	readonly state: "not_enabled" | "denied" | "failing"
	readonly regions: ReadonlyArray<string>
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
		return acc.set(key, {
			source: service.source,
			state: service.state,
			regions: Arr.sort(Arr.dedupe([...(seen?.regions ?? []), service.region]), Order.String),
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
 * Which enabled services' findings arrive as events (EventBridge, from the setup script), within the
 * poller's window. Null before any service is read.
 */
export const deliveryOf = (
	overview: Overview,
	nowMs: number,
): { readonly live: ReadonlyArray<CloudFindingSource>; readonly allLive: boolean } | null => {
	const enabled = Arr.filter(overview.services, (service) => service.state === "enabled")
	if (enabled.length === 0) return null
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
	return { live, allLive: live.length === sourcesOf(enabled).length }
}

/** The accounts and regions the filters offer: every connected account, every region polled. */
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
