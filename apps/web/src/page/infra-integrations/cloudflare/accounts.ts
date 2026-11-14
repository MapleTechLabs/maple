import type { CloudflareConnectedAccountStatus } from "@maple/domain/http"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { Array as Arr } from "effect"

/** A sync older than this is "delayed": the poller runs every few minutes. */
export const STALE_SYNC_MS = 30 * 60_000

export type AccountTone = "ok" | "warn" | "crit"

export interface AccountHealth {
	tone: AccountTone
	/** One line: "synced 2m ago", "2 of 5 zones not syncing", "Workers analytics failing". */
	message: string
}

export interface CloudflareAccount {
	accountId: string
	name: string
	/** Zone names the poller covers for this account. */
	zones: ReadonlyArray<string>
	health: AccountHealth
}

/**
 * Health from the poller's own bookkeeping, worst first: zones with errors, then a stale sync, then
 * a failing Workers dataset. A revoked grant is grant-wide, so the page states it once, not per account.
 */
export function accountHealth(account: CloudflareConnectedAccountStatus, now: number): AccountHealth {
	const zones = Arr.filter(account.zones, (zone) => zone.enabled)
	const failing = Arr.filter(zones, (zone) => zone.lastError !== null)
	if (failing.length > 0) {
		return {
			tone: "crit",
			message:
				failing.length === zones.length
					? `${failing.length === 1 ? "Its zone is" : `All ${zones.length} zones are`} not syncing`
					: `${failing.length} of ${zones.length} zones not syncing`,
		}
	}
	// The oldest dataset, not the newest: a fresh Workers sync must not hide a zone that stopped.
	const synced = Arr.filter(
		[
			...Arr.map(zones, (zone) => zone.lastSyncedAt),
			account.workers?.enabled ? account.workers.lastSyncedAt : null,
		],
		(at): at is number => at !== null,
	)
	const oldest = synced.length === 0 ? null : Math.min(...synced)
	if (oldest !== null && now - oldest > STALE_SYNC_MS) {
		return { tone: "warn", message: `Delayed · last sync ${formatRelativeFrom(oldest, now)}` }
	}
	if (account.workers?.lastError) return { tone: "warn", message: "Workers analytics failing" }
	return {
		tone: "ok",
		message: oldest === null ? "waiting for first sync" : `synced ${formatRelativeFrom(oldest, now)}`,
	}
}

export function cloudflareAccounts(
	accounts: ReadonlyArray<CloudflareConnectedAccountStatus>,
	now: number,
): CloudflareAccount[] {
	return Arr.map(accounts, (account) => ({
		accountId: account.accountId,
		name: account.accountName ?? account.accountId,
		zones: Arr.map(account.zones, (zone) => zone.name),
		health: accountHealth(account, now),
	}))
}

/** Zone service name to account id. Zone rows carry no account attribute; the poller knows. */
export function zoneAccountIds(accounts: ReadonlyArray<CloudflareAccount>): ReadonlyMap<string, string> {
	return new Map(
		Arr.flatMap(accounts, (account) =>
			Arr.map(account.zones, (zone) => [`cloudflare/${zone}`, account.accountId]),
		),
	)
}
