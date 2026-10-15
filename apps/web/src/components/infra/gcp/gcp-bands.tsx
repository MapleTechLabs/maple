// The band above each Google Cloud list: every row by its worst signal, and one cell per problem
// that scopes the list to it. Counts are over the rows before a scope or search, so the band shows
// what they hide.

import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { FLEET_BAND_BOXED, FleetBand, FleetBandLoading } from "../primitives/fleet-band"
import type { Tone } from "../severity-tokens"
import {
	rowHealth,
	type GcpDatabaseScope,
	type GcpServiceScope,
	type GcpSubscriptionScope,
	type GcpWorkloadScope,
	type RowRules,
} from "./list-model"

interface CellSpec {
	readonly label: string
	readonly hint: string
	readonly tone: Tone
	/** The row's health in the strip's label: "serving 5xx". */
	readonly segment: string
}

/** What a list's band says: its noun, its honesty line, and a cell per scope. */
export interface GcpBandSpec<S extends string> {
	readonly noun: string
	readonly caption: string
	readonly cells: Readonly<Record<S, CellSpec>>
}

export const GCP_SERVICE_BAND: GcpBandSpec<GcpServiceScope> = {
	noun: "service",
	caption: "each service by its worst signal: 5xx, then p95 latency",
	cells: {
		serving5xx: {
			label: "Serving 5xx",
			hint: "≥1% of ≥100 requests",
			tone: "crit",
			segment: "serving 5xx",
		},
		slow: { label: "Slow", hint: "latency p95 ≥1s", tone: "warn", segment: "slow" },
		idle: {
			label: "Idle, still billed",
			hint: "0 requests, instance time > 0",
			tone: "neutral",
			segment: "idle",
		},
	},
}

export const GCP_SUBSCRIPTION_BAND: GcpBandSpec<GcpSubscriptionScope> = {
	noun: "subscription",
	caption: "each subscription by its worst signal: backlog, dead letters, age",
	cells: {
		backlogGrowing: {
			label: "Backlog growing",
			hint: "unacked up across the window",
			tone: "crit",
			segment: "backlog growing",
		},
		stale: { label: "Stale", hint: "oldest unacked ≥10m", tone: "warn", segment: "stale" },
		deadLettering: {
			label: "Dead-lettering",
			hint: "messages moved to a DLQ",
			tone: "crit",
			segment: "dead-lettering",
		},
	},
}

export const GCP_DATABASE_BAND: GcpBandSpec<GcpDatabaseScope> = {
	noun: "instance",
	caption: "each instance by its worst signal: a limit, wraparound, then query p95",
	cells: {
		atLimit: {
			label: "At a limit",
			hint: "connections, CPU or disk ≥90%",
			tone: "crit",
			segment: "at a limit",
		},
		slow: { label: "Slow", hint: "query p95 ≥1s", tone: "warn", segment: "slow" },
		wraparound: {
			label: "Wraparound risk",
			hint: "transaction IDs ≥50% used",
			tone: "warn",
			segment: "wraparound risk",
		},
		fillingUp: {
			label: "Filling up",
			hint: "connections, CPU or disk ≥80%",
			tone: "warn",
			segment: "filling up",
		},
		replicaLag: {
			label: "Replica lag",
			hint: "a replica ≥10s behind",
			tone: "warn",
			segment: "replica lag",
		},
	},
}

export const gcpWorkloadBand = (noun: string): GcpBandSpec<GcpWorkloadScope> => ({
	noun,
	caption: `each ${noun} by its busiest share of a limit and its error rate`,
	cells: {
		atLimit: {
			label: "At a limit",
			hint: "a share of a limit ≥90%",
			tone: "crit",
			segment: "at a limit",
		},
		hot: { label: "Hot", hint: "a share of a limit ≥60%", tone: "warn", segment: "hot" },
		erroring: { label: "Erroring", hint: "≥5% of ≥100 requests", tone: "crit", segment: "erroring" },
	},
})

/** A row's dot: its worst signal's tone, hollow for a quiet problem, blue when healthy. */
export function GcpHealthDot<S extends string>({ spec, health }: { spec: GcpBandSpec<S>; health: S | "ok" }) {
	const tone = health === "ok" ? "ok" : spec.cells[health].tone
	return (
		<span
			aria-hidden
			className={cn(
				"size-2 shrink-0 rounded-full",
				tone === "neutral" ? "border border-muted-foreground/70" : TONE_FILL[tone],
			)}
		/>
	)
}

export function GcpBand<R, S extends string>({
	rows,
	rules,
	spec,
	activeScope,
	onScopeChange,
}: {
	rows: ReadonlyArray<R>
	rules: RowRules<R, S>
	spec: GcpBandSpec<S>
	activeScope: S | undefined
	onScopeChange: (scope: S | undefined) => void
}) {
	const healths = rows.map((row) => rowHealth(rules, row))
	const count = (health: S | "ok") => healths.filter((candidate) => candidate === health).length
	return (
		<FleetBand<S>
			total={rows.length}
			noun={spec.noun}
			caption={spec.caption}
			segments={[
				{ key: "healthy", count: count("ok"), className: TONE_FILL.ok },
				// The mildest problem nearest the healthy share, the worst at the end.
				...rules.worst.toReversed().map((scope) => ({
					key: spec.cells[scope].segment,
					count: count(scope),
					className: TONE_FILL[spec.cells[scope].tone],
				})),
			]}
			cells={rules.scopes.map((scope) => ({
				scope,
				label: spec.cells[scope].label,
				hint: spec.cells[scope].hint,
				tone: spec.cells[scope].tone,
				value: rows.filter((row) => rules.inScope(row, scope)).length,
			}))}
			activeScope={activeScope}
			onScopeChange={onScopeChange}
			className={FLEET_BAND_BOXED}
		/>
	)
}

export function GcpBandLoading() {
	return <FleetBandLoading cells={3} className={FLEET_BAND_BOXED} />
}
