import type {
	CloudflareIntegrationStatus,
	CloudflareServiceUsage,
	CloudflareUsageResponse,
} from "@maple/domain/http"
import type { ZoneChoice } from "./cloudflare"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { Array as Arr, String as Str, Option } from "effect"

// The pure halves of `CloudflareZoneBoard` and `CloudflareAccountCard`: row usage, error descriptions, the
// zone status rules, and the entries the board renders.

const HOUR_MS = 3_600_000

export interface RowUsage {
	readonly totalRequests: number
	readonly lastDataAt: number | null
	readonly points: ReadonlyArray<number>
}

/** Zero-fill the sparse hourly buckets across the whole window so gaps read as gaps. */
const fillHourlyPoints = (usage: CloudflareUsageResponse, byStart: ReadonlyMap<number, number>) => {
	const first = Math.floor(usage.windowStart / HOUR_MS) * HOUR_MS
	const count = Math.max(0, Math.floor((usage.windowEnd - first) / HOUR_MS) + 1)
	return Array.from({ length: count }, (_, index) => byStart.get(first + index * HOUR_MS) ?? 0)
}

/** `toRowUsage`: one or more services merged into a single readout. */
export const toRowUsage = (
	usage: CloudflareUsageResponse,
	services: ReadonlyArray<CloudflareServiceUsage>,
): RowUsage => {
	const summed = new Map<number, number>()
	Arr.forEach(services, (service) =>
		Arr.forEach(service.buckets, (bucket) =>
			summed.set(bucket.bucketStart, (summed.get(bucket.bucketStart) ?? 0) + bucket.requests),
		),
	)
	const lastDataAt = Arr.reduce<(typeof services)[number], number | null>(services, null, (acc, service) =>
		service.lastDataAt === null || service.lastDataAt === undefined
			? acc
			: acc === null
				? service.lastDataAt
				: Math.max(acc, service.lastDataAt),
	)
	return {
		totalRequests: Arr.reduce(services, 0, (sum, service) => sum + service.totalRequests),
		lastDataAt,
		points: fillHourlyPoints(usage, summed),
	}
}

export type CloudflareErrorTone = Extract<Tone, "crit" | "warn">

export interface CloudflareErrorInfo {
	readonly summary: string
	readonly tone: CloudflareErrorTone
	readonly scope: "account" | "resource"
}

/** `describeCloudflareError`: a friendly readout of the poller's free-form `lastError`. */
export const describeCloudflareError = (raw: string): CloudflareErrorInfo => {
	const s = Str.toLowerCase(raw)
	const has = (...needles: ReadonlyArray<string>) => Arr.some(needles, (needle) => Str.includes(needle)(s))
	if (has("revoked", "no longer valid"))
		return {
			summary: "Cloudflare access was revoked. Reconnect to resume.",
			tone: "crit",
			scope: "account",
		}
	if (has("lacks the analytics scopes", "scope"))
		return { summary: "Reconnect to grant Maple analytics access.", tone: "warn", scope: "account" }
	if (has("cloudflare_oauth_client_id", "is required", "ingest key unavailable"))
		return {
			summary: "Traffic collection is temporarily unavailable. Try again shortly.",
			tone: "crit",
			scope: "account",
		}
	if (has("not authenticated", "not authorized", "unauthorized", "access denied"))
		return {
			summary: "Cloudflare denied the request. Reconnect to refresh access.",
			tone: "crit",
			scope: "account",
		}
	if (has("no longer present"))
		return {
			summary: "This zone was removed from your Cloudflare account.",
			tone: "warn",
			scope: "resource",
		}
	if (has("not enabled", "disabled"))
		return {
			summary: "Analytics isn't enabled for this zone in Cloudflare.",
			tone: "warn",
			scope: "resource",
		}
	if (has("unknown field", "cannot query"))
		return {
			summary: "Some analytics aren't available on this Cloudflare plan.",
			tone: "warn",
			scope: "resource",
		}
	return { summary: raw, tone: "crit", scope: "resource" }
}

export const isAccountScoped = (raw: string | null): boolean =>
	raw !== null && describeCloudflareError(raw).scope === "account"

/** `watched` is optional on the wire for deploy-window compat; absent means collected. */
const isWatched = (zone: { readonly watched?: boolean }): boolean => zone.watched ?? true

export interface ZoneEntry {
	readonly key: string
	readonly name: string
	readonly enabled: boolean
	/** False when the customer paused collection for this zone. */
	readonly watched: boolean
	readonly lastSyncedAt: number | null
	readonly lastError: string | null
	readonly usage: RowUsage | null
}

export type ZoneStatusKind = "live" | "issue" | "no-data" | "paused" | "disabled"

/** `detail` is text, or an error line (`ErrorLine`: summary plus the raw string behind "Details"). */
export type ZoneDetail =
	| Readonly<{ _tag: "Text"; text: string }>
	/** `Last data 3m ago`: a lead-in and the instant it reads relative to the page clock. */
	| Readonly<{ _tag: "Since"; text: string; at: number }>
	| Readonly<{ _tag: "Error"; summary: string; raw: string }>

export interface ZoneStatusInfo {
	readonly kind: ZoneStatusKind
	readonly tone: Tone
	readonly detail: ZoneDetail
	readonly detailClass: string
}

export const STATUS_META = {
	live: { label: "Live", order: 0, tone: "ok" },
	issue: { label: "Issues", order: 1, tone: "crit" },
	"no-data": { label: "No data", order: 2, tone: "neutral" },
	paused: { label: "Paused", order: 3, tone: "neutral" },
	disabled: { label: "Disabled", order: 4, tone: "neutral" },
} as const satisfies { readonly [K in ZoneStatusKind]: { label: string; order: number; tone: Tone } }

export const CHIP_ORDER: ReadonlyArray<ZoneStatusKind> = ["live", "issue", "no-data", "paused", "disabled"]

export const rowHasData = (usage: RowUsage | null): boolean =>
	usage !== null && (usage.totalRequests > 0 || usage.lastDataAt !== null)

const text = (value: string): ZoneDetail => ({ _tag: "Text", text: value })
const muted = "text-muted-foreground"

/** `zoneStatus`: the one health derivation behind the dot, the detail, the chips and the sort. */
export const zoneStatus = (entry: ZoneEntry, usageLoaded: boolean): ZoneStatusInfo => {
	const { enabled, lastError, usage, lastSyncedAt } = entry
	const err = lastError !== null && lastError !== "" ? describeCloudflareError(lastError) : null
	if (!entry.watched)
		return { kind: "paused", tone: "neutral", detail: text("Paused by you"), detailClass: muted }
	if (!enabled) return { kind: "disabled", tone: "neutral", detail: text("Disabled"), detailClass: muted }
	if (err !== null && err.scope === "account")
		return { kind: "paused", tone: "neutral", detail: text("Paused"), detailClass: muted }
	if (err !== null && lastError !== null)
		return {
			kind: "issue",
			tone: err.tone,
			detail: { _tag: "Error", summary: err.summary, raw: lastError },
			detailClass: TONE_TEXT[err.tone],
		}
	if (rowHasData(usage))
		return {
			kind: "live",
			tone: "ok",
			detail:
				usage?.lastDataAt !== null && usage?.lastDataAt !== undefined
					? { _tag: "Since", text: "Last data", at: usage.lastDataAt }
					: text("Receiving data"),
			detailClass: muted,
		}
	const synced = lastSyncedAt !== null && lastSyncedAt !== 0
	if (usageLoaded && synced)
		return {
			kind: "no-data",
			tone: "neutral",
			detail: text("No data in last 24h"),
			detailClass: TONE_TEXT.neutral,
		}
	if (synced && lastSyncedAt !== null)
		return {
			kind: "live",
			tone: "ok",
			detail: { _tag: "Since", text: "Checked", at: lastSyncedAt },
			detailClass: muted,
		}
	return {
		kind: "no-data",
		tone: "neutral",
		detail: text("Waiting for first data"),
		detailClass: TONE_TEXT.neutral,
	}
}

const EMPTY_USAGE: RowUsage = { totalRequests: 0, lastDataAt: null, points: [] }

export const workerServicesOf = (
	usage: CloudflareUsageResponse | null,
): ReadonlyArray<CloudflareServiceUsage> =>
	usage === null ? [] : Arr.filter(usage.services, (service) => service.kind === "worker")

/** One entry per zone (poller state joined with usage), plus zones only the warehouse knows. */
export const zoneEntriesOf = (
	status: CloudflareIntegrationStatus,
	usage: CloudflareUsageResponse | null,
): ReadonlyArray<ZoneEntry> => {
	const zoneUsage = (name: string): RowUsage | null => {
		if (usage === null) return null
		return Option.match(
			Arr.findFirst(usage.services, (s) => s.kind === "zone" && s.displayName === name),
			{ onNone: () => EMPTY_USAGE, onSome: (service) => toRowUsage(usage, [service]) },
		)
	}
	const known = new Set(Arr.map(status.zones, (zone) => zone.name))
	const unmatched =
		usage === null
			? []
			: Arr.filter(
					usage.services,
					(service) => service.kind === "zone" && !known.has(service.displayName),
				)
	return [
		...Arr.map(status.zones, (zone) => ({
			key: zone.id,
			name: zone.name,
			enabled: zone.enabled,
			watched: isWatched(zone),
			lastSyncedAt: zone.lastSyncedAt ?? null,
			lastError: zone.lastError ?? null,
			usage: zoneUsage(zone.name),
		})),
		...Arr.map(unmatched, (service) => ({
			key: service.serviceName,
			name: service.displayName,
			enabled: true,
			watched: true,
			lastSyncedAt: null,
			lastError: null,
			usage: usage === null ? null : toRowUsage(usage, [service]),
		})),
	]
}

/** The Workers aggregate in the zone-entry shape (drives the side card's problem line). */
export const workerEntryOf = (
	status: CloudflareIntegrationStatus,
	usage: CloudflareUsageResponse | null,
): ZoneEntry => {
	const services = workerServicesOf(usage)
	return {
		key: "workers",
		name: "Workers",
		enabled: status.workers?.enabled ?? true,
		watched: true,
		lastSyncedAt: status.workers?.lastSyncedAt ?? null,
		lastError: status.workers?.lastError ?? null,
		usage: usage === null ? null : services.length > 0 ? toRowUsage(usage, services) : EMPTY_USAGE,
	}
}

/** The first account-wide failure, surfaced once as a banner. */
export const accountErrorOf = (
	status: CloudflareIntegrationStatus,
): (CloudflareErrorInfo & { readonly raw: string }) | null => {
	const raw = Arr.findFirst(
		[status.workers?.lastError ?? null, ...Arr.map(status.zones, (zone) => zone.lastError ?? null)],
		(value): value is string => value !== null && value !== "" && isAccountScoped(value),
	)
	return Option.match(raw, {
		onNone: () => null,
		onSome: (error) => ({ ...describeCloudflareError(error), raw: error }),
	})
}

export interface ConnectedAccountEntry {
	readonly accountId: string
	readonly accountName: string | null
	readonly analyticsCapable: boolean
	readonly revoked: boolean
	readonly zoneCount: number
}

export const connectedAccountsOf = (
	status: CloudflareIntegrationStatus,
): ReadonlyArray<ConnectedAccountEntry> => {
	if (!status.connected) return []
	const list = status.accounts ?? []
	if (list.length > 0)
		return Arr.map(list, (account) => ({
			accountId: account.accountId,
			accountName: account.accountName,
			analyticsCapable: account.analyticsCapable,
			revoked: account.revoked,
			zoneCount: account.zones.length,
		}))
	return status.accountId === null || status.accountId === undefined
		? []
		: [
				{
					accountId: status.accountId,
					accountName: status.accountName,
					analyticsCapable: status.analyticsCapable,
					revoked: false,
					zoneCount: status.zones.length,
				},
			]
}

/** The stored zone choice per account; a pre-`accounts` status reads as its single account. */
export const zoneChoicesOf = (status: CloudflareIntegrationStatus): ReadonlyArray<ZoneChoice> => {
	const toZones = (zones: CloudflareIntegrationStatus["zones"]) =>
		Arr.sort(
			Arr.map(zones, (zone) => ({ id: zone.id, name: zone.name, watched: isWatched(zone) })),
			(a: { readonly name: string }, b: { readonly name: string }) => Str.localeCompare(b.name)(a.name),
		)
	const accounts = status.accounts ?? []
	if (accounts.length > 0)
		return Arr.map(accounts, (account) => ({
			accountId: account.accountId,
			accountName: account.accountName,
			watchNewZones: account.watchNewZones ?? true,
			zones: toZones(account.zones),
		}))
	return status.accountId === null || status.accountId === undefined
		? []
		: [
				{
					accountId: status.accountId,
					accountName: status.accountName,
					watchNewZones: true,
					zones: toZones(status.zones),
				},
			]
}

/** The accounts whose draft differs from what is stored: only those are saved. */
export const changedZoneChoices = (
	stored: ReadonlyArray<ZoneChoice>,
	draft: ReadonlyArray<ZoneChoice>,
): ReadonlyArray<ZoneChoice> =>
	Arr.filter(draft, (account) => {
		const found = Arr.findFirst(stored, (entry) => entry.accountId === account.accountId)
		if (Option.isNone(found)) return true
		const before = found.value
		const watchedBefore = new Map(Arr.map(before.zones, (zone) => [zone.id, zone.watched]))
		return (
			before.watchNewZones !== account.watchNewZones ||
			Arr.some(account.zones, (zone) => watchedBefore.get(zone.id) !== zone.watched)
		)
	})
