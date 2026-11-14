import { AsyncData } from "foldkit"
import type { Keyed } from "@maple/views/data/keyed"

// What the hub shows of an integration before its card: the header badge and the catalog row.

/** Success (also while revalidating), initial (`null`), else the failure value. */
export const fold = <A, E, R>(slot: Keyed<A, E>, onSuccess: (data: A) => R, onFailure: () => R): R | null =>
	AsyncData.match(slot.data, {
		onIdle: () => null,
		onLoading: () => null,
		onRefreshing: onSuccess,
		onSuccess,
		onFailure: () => onFailure(),
		onStale: () => onFailure(),
	})

export interface CardStatus {
	readonly label: string
	readonly variant: "ok" | "warn" | "crit" | "outline"
}

export const NOT_CONNECTED: CardStatus = { label: "Not connected", variant: "outline" }
export const NOT_CONFIGURED: CardStatus = { label: "Not configured", variant: "outline" }
/** The status read failed: a warning, not the neutral look of a quiet connection. */
export const STATUS_UNAVAILABLE: CardStatus = { label: "Couldn't check status", variant: "warn" }

/** The newest data or sync, read as `{verb} {relative time}`: `synced 3m ago`. */
export type LastSync = Readonly<{ verb: string; at: number }>

export interface ConnectedOverview {
	readonly kind: "connected"
	readonly health: "healthy" | "attention" | "pending"
	readonly stateLabel: string
	readonly context: string | null
	readonly stat: string | null
	readonly lastSync: LastSync | null
	readonly issue: string | null
}
export interface AvailableOverview {
	readonly kind: "available"
	readonly cta: "Connect" | "Set up"
}
export interface UnavailableOverview {
	readonly kind: "unavailable"
	/** `failed`: the status read failed. `not-configured`: this deployment has no setup for it. */
	readonly reason: "failed" | "not-configured"
}
export type IntegrationOverview = ConnectedOverview | AvailableOverview | UnavailableOverview | null

export const CONNECT: AvailableOverview = { kind: "available", cta: "Connect" }
export const SET_UP: AvailableOverview = { kind: "available", cta: "Set up" }
export const UNAVAILABLE: UnavailableOverview = { kind: "unavailable", reason: "failed" }
export const UNCONFIGURED: UnavailableOverview = { kind: "unavailable", reason: "not-configured" }

export const lastSyncOf = (ms: number | null, verb = "synced"): LastSync | null =>
	ms === null ? null : { verb, at: ms }

export const unavailableStatus = () => STATUS_UNAVAILABLE
export const unavailableOverview = (): IntegrationOverview => UNAVAILABLE
export const attentionOr = (issue: string | null) =>
	({
		health: issue !== null ? "attention" : "healthy",
		stateLabel: issue !== null ? "Needs attention" : "Healthy",
	}) as const
