import { describe, expect, it } from "vitest"

import {
	CloudflareAnalyticsWorkersStatus,
	CloudflareAnalyticsZoneStatus,
	CloudflareConnectedAccountStatus,
} from "@maple/domain/http"

import { accountHealth, cloudflareAccounts, zoneAccountIds } from "./accounts"

const NOW = 1_800_000_000_000
const MINUTE = 60_000

const zone = (name: string, lastSyncedAt: number | null, lastError: string | null = null) =>
	new CloudflareAnalyticsZoneStatus({
		id: name,
		name,
		enabled: true,
		lastSyncedAt,
		lastError,
		watermarkAt: lastSyncedAt,
	})

const account = (
	zones: ReadonlyArray<CloudflareAnalyticsZoneStatus>,
	workersError: string | null = null,
	name = "Acme Production",
) =>
	new CloudflareConnectedAccountStatus({
		accountId: name.toLowerCase().replace(" ", "-"),
		accountName: name,
		connectedByUserId: null,
		scope: "analytics",
		analyticsCapable: true,
		revoked: false,
		zones,
		workers: new CloudflareAnalyticsWorkersStatus({
			enabled: true,
			lastSyncedAt: NOW - 2 * MINUTE,
			lastError: workersError,
			watermarkAt: NOW - 2 * MINUTE,
		}),
	})

describe("accountHealth", () => {
	it("is healthy with a recent sync", () => {
		expect(accountHealth(account([zone("acme.com", NOW - 2 * MINUTE)]), NOW)).toEqual({
			tone: "ok",
			message: "synced 2m ago",
		})
	})

	it("counts zones that stopped syncing ahead of everything else", () => {
		const health = accountHealth(
			account([
				zone("a.com", NOW, "rate limited"),
				zone("b.com", NOW, "rate limited"),
				zone("c.com", NOW),
			]),
			NOW,
		)
		expect(health).toEqual({ tone: "crit", message: "2 of 3 zones not syncing" })
	})

	it("calls a sync older than half an hour delayed", () => {
		const stale = new CloudflareConnectedAccountStatus({
			...account([zone("a.com", NOW - 47 * MINUTE)]),
			workers: null,
		})
		expect(accountHealth(stale, NOW)).toEqual({ tone: "warn", message: "Delayed · last sync 47m ago" })
	})

	it("does not let a fresh Workers sync hide a zone that stopped syncing", () => {
		expect(accountHealth(account([zone("a.com", NOW - 47 * MINUTE)]), NOW)).toEqual({
			tone: "warn",
			message: "Delayed · last sync 47m ago",
		})
	})

	it("flags a failing Workers dataset when zones are fine", () => {
		expect(accountHealth(account([zone("a.com", NOW)], "permission denied"), NOW).tone).toBe("warn")
	})
})

describe("zoneAccountIds", () => {
	it("maps each zone's service name to its account", () => {
		const accounts = cloudflareAccounts(
			[account([zone("acme.com", NOW)]), account([zone("acme.blog", NOW)], null, "Acme Marketing")],
			NOW,
		)
		expect(Object.fromEntries(zoneAccountIds(accounts))).toEqual({
			"cloudflare/acme.com": "acme-production",
			"cloudflare/acme.blog": "acme-marketing",
		})
	})
})
