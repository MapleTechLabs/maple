import { AuditTrailProvider } from "@maple/domain/audit-trail"
import type { AuditTrailSource, AuditTrailSourceState } from "@maple/domain/http"
import type {
	IntegrationEntry,
	IntegrationInventory,
	IntegrationResource,
} from "@maple/domain/integration-inventory"
import { Array as Arr, Option } from "effect"

// Which platforms feed the audit log and how each is doing: the events the table holds per
// platform, read against each integration's switches and health. Pure, like the inventory itself.

/** What the table holds for one platform in the window. */
export interface AuditTrailProviderStats {
	readonly provider: string
	readonly events: number
	readonly lastEventAt: number | null
}

/** Where each connectable platform's audit feed lives in its integration. */
const FEED_OF = {
	// The "Maple audit log" drain, one of the drains the Vercel integration installs.
	vercel: (resource: IntegrationResource) => resource.kind === "drain" && resource.name === "audit log",
	// Admin Activity and Policy Denied ride the log sink the setup script creates.
	gcp: (resource: IntegrationResource) => resource.kind === "logs",
	// CloudTrail rides the connection's `security` module, read by the findings poller.
	aws: (resource: IntegrationResource) => resource.kind === "audit log",
} as const satisfies Record<Exclude<AuditTrailProvider, "maple">, (resource: IntegrationResource) => boolean>

type ConnectableProvider = keyof typeof FEED_OF

const isBroken = (status: IntegrationResource["status"]) => status === "failing" || status === "disconnected"

const connectableState = (
	provider: ConnectableProvider,
	inventory: IntegrationInventory | null,
	stats: AuditTrailProviderStats | undefined,
): { state: AuditTrailSourceState; account: string | null; problem: string | null } => {
	const received = (stats?.events ?? 0) > 0
	// Without the inventory the page still says what arrived; a quiet feed reads as waiting.
	if (inventory === null) return { state: received ? "receiving" : "waiting", account: null, problem: null }
	const entry: IntegrationEntry | undefined = Option.getOrUndefined(
		Arr.findFirst(inventory.integrations, (candidate) => candidate.provider === provider),
	)
	if (entry === undefined)
		// Events from a connection removed since still show; the platform reads as not connected.
		return { state: "not_connected", account: null, problem: null }
	const feeds = Arr.filter(entry.resources, FEED_OF[provider])
	if (entry.status === "disconnected")
		return { state: "failing", account: entry.account, problem: entry.problem }
	if (feeds.length === 0) return { state: "off", account: entry.account, problem: null }
	const broken = Arr.findFirst(feeds, (feed) => isBroken(feed.status))
	if (Option.isSome(broken))
		return {
			state: "failing",
			account: entry.account,
			problem: broken.value.lastError ?? broken.value.note ?? entry.problem,
		}
	return { state: received ? "receiving" : "waiting", account: entry.account, problem: null }
}

/**
 * Every platform the audit log can hold, Maple first, then the connectable ones, then any
 * platform a newer writer added that this build has no setup for. `inventory` is null when the
 * integration state could not be read.
 */
export const auditTrailSources = (
	stats: ReadonlyArray<AuditTrailProviderStats>,
	inventory: IntegrationInventory | null,
): ReadonlyArray<AuditTrailSource> => {
	const statsOf = (provider: string) =>
		Option.getOrUndefined(Arr.findFirst(stats, (row) => row.provider === provider))
	const counts = (provider: string) => {
		const row = statsOf(provider)
		return { events: row?.events ?? 0, lastEventAt: row?.lastEventAt ?? null }
	}
	const known = AuditTrailProvider.literals
	return [
		{ provider: "maple", state: "built_in", account: null, problem: null, ...counts("maple") },
		...Arr.map(
			Arr.filter(known, (provider): provider is ConnectableProvider => provider !== "maple"),
			(provider): AuditTrailSource => ({
				provider,
				...connectableState(provider, inventory, statsOf(provider)),
				...counts(provider),
			}),
		),
		...Arr.map(
			Arr.filter(
				stats,
				(row) => row.events > 0 && !Arr.some(known, (provider) => provider === row.provider),
			),
			(row): AuditTrailSource => ({
				provider: row.provider,
				state: "receiving",
				account: null,
				problem: null,
				events: row.events,
				lastEventAt: row.lastEventAt,
			}),
		),
	]
}
