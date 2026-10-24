import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"

// The server's status and the connection to it, as data.

/** Consecutive refused probes before the app swaps to the "can't reach" screen. */
export const MISSES_BEFORE_DOWN = 2
export const POLL_MS = 5_000
/** After one refused probe, look again quickly: two misses in a row mean "down". */
export const RECHECK_MS = 1_000
/** chDB answers one request at a time, so a slow query holds the probe; past this it reads as busy. */
export const PROBE_TIMEOUT_MS = 3_000
/** Legacy binaries (no `/local/status`): newest span/log in this window stands in for arrival time. */
export const LEGACY_WINDOW_MS = 10 * 60 * 1000
/** The server-rendered sign-in page of a self-hosted server with an access token. */
export const LOGIN_PATH = "/login"

export const Reachability = Schema.Literals(["connected", "busy", "refused", "rejected", "failing"])
export type Reachability = typeof Reachability.Type

export const Rejection = Schema.Struct({ status: Schema.Number, detail: Schema.String })
export type Rejection = typeof Rejection.Type

export const ServerState = Schema.Struct({
	reachability: Reachability,
	/** Consecutive probes that found nothing listening. */
	misses: Schema.Number,
	/** When the server last accepted a non-empty OTLP batch of any signal (epoch ms). */
	lastIngestAtMs: Schema.NullOr(Schema.Number),
	/** True for a binary without `/local/status`, where the time above is the newest event time. */
	legacy: Schema.Boolean,
	rejection: Schema.NullOr(Rejection),
	/** Epoch ms of this probe; changes every poll so relative labels stay fresh. */
	checkedAtMs: Schema.Number,
	/** Whether any probe in this page's life reached the server. */
	hasConnected: Schema.Boolean,
})
export type ServerState = typeof ServerState.Type

/** One probe's outcome (`StatusProbe`), with the legacy fallback's newest event already read. */
export const ProbeOutcome = defineTaggedUnion({
	Ok: { lastIngestAtMs: Schema.NullOr(Schema.Number) },
	/** 404: an older binary; `lastSeen` is none when its fallback query failed or timed out. */
	Legacy: { maybeLastSeen: Schema.Option(Schema.NullOr(Schema.Number)) },
	Busy: {},
	Refused: {},
	Rejected: { status: Schema.Number, detail: Schema.String },
})
export type ProbeOutcome = typeof ProbeOutcome.Type
