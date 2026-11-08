import { AlertMaintenanceWindowId, AlertRuleId, AlertSilenceId } from "@maple/domain/http"
import type { V2AlertMaintenanceWindow, V2AlertSilence } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { msIso } from "./time"
import { NOW, ruleId } from "./test-rows"

// Maintenance windows and their silences for the scene tests and `/lab/maintenance`.
// `NOW` is Thursday 2026-10-01 12:00 UTC.

const MIN = 60_000

export const windowUuid = (n: number): string => `0199a00f-0000-7000-8000-00000000000${n}`
export const windowId = (n: number) => Schema.decodeSync(AlertMaintenanceWindowId)(windowUuid(n))

const base = (n: number): V2AlertMaintenanceWindow => ({
	id: windowId(n),
	object: "alert_maintenance_window",
	name: `Window ${n}`,
	reason: null,
	matchers: { services: ["checkout"] },
	schedule: {
		type: "weekly",
		time_zone: "Europe/Berlin",
		days: ["mon", "thu"],
		start_time: "02:00",
		duration_minutes: 120,
	},
	exclude_from_baselines: true,
	enabled: true,
	next_occurrence: null,
	created_by: "user_1",
	created_at: msIso(NOW - 7 * 24 * 60 * MIN),
	updated_at: msIso(NOW - 7 * 24 * 60 * MIN),
})

/** Weekly, Mon and Thu at 02:00 Berlin for 2h; the next one is Monday's. */
export const weeklyWindow: V2AlertMaintenanceWindow = {
	...base(1),
	name: "Nightly database backup",
	reason: "Snapshot and vacuum",
	matchers: { services: ["checkout", "payments"], environments: ["production"] },
	next_occurrence: {
		// Monday 2026-10-05 02:00 in Berlin (CEST) is 00:00 UTC.
		starts_at: msIso(NOW + 84 * 60 * MIN),
		ends_at: msIso(NOW + 86 * 60 * MIN),
	},
}

/** A one-off window running now, for 90 more minutes. */
export const runningWindow: V2AlertMaintenanceWindow = {
	...base(2),
	name: "Checkout v3 migration",
	matchers: { rule_ids: [Schema.decodeSync(AlertRuleId)(ruleId(1))], environments: ["production"] },
	schedule: { type: "once", starts_at: msIso(NOW - 30 * MIN), ends_at: msIso(NOW + 90 * MIN) },
	exclude_from_baselines: true,
	next_occurrence: { starts_at: msIso(NOW - 30 * MIN), ends_at: msIso(NOW + 90 * MIN) },
}

/** A one-off window that ran last week. */
export const endedWindow: V2AlertMaintenanceWindow = {
	...base(3),
	name: "Datacenter move",
	matchers: { tags: ["infra"] },
	schedule: {
		type: "once",
		starts_at: msIso(NOW - 6 * 24 * 60 * MIN),
		ends_at: msIso(NOW - 6 * 24 * 60 * MIN + 4 * 60 * MIN),
	},
	exclude_from_baselines: false,
	next_occurrence: null,
}

/** A weekend window someone turned off. */
export const disabledWindow: V2AlertMaintenanceWindow = {
	...base(4),
	name: "Weekend reindex",
	matchers: { tags: ["db"] },
	schedule: {
		type: "weekly",
		time_zone: "UTC",
		days: ["sat", "sun"],
		start_time: "23:30",
		duration_minutes: 90,
	},
	exclude_from_baselines: false,
	enabled: false,
}

export const populatedWindows: ReadonlyArray<V2AlertMaintenanceWindow> = [
	runningWindow,
	weeklyWindow,
	disabledWindow,
	endedWindow,
]

const silenceUuid = (n: number) => `0199a010-0000-7000-8000-00000000000${n}`

/** A silence; `window` makes it one of that window's occurrences. */
export const silenceOf = (
	n: number,
	fields: Readonly<{
		reason: string
		startMin: number
		endMin: number
		window?: V2AlertMaintenanceWindow
		matchers?: V2AlertSilence["matchers"]
	}>,
): V2AlertSilence => ({
	id: Schema.decodeSync(AlertSilenceId)(silenceUuid(n)),
	object: "alert_silence",
	reason: fields.reason,
	matchers: fields.matchers ?? fields.window?.matchers ?? { services: ["checkout"] },
	status: fields.endMin <= 0 ? "ended" : fields.startMin > 0 ? "scheduled" : "active",
	starts_at: msIso(NOW + fields.startMin * MIN),
	ends_at: msIso(NOW + fields.endMin * MIN),
	maintenance_window_id: fields.window?.id ?? null,
	created_by: "user_1",
	created_at: msIso(NOW),
	updated_at: msIso(NOW),
})

/** A manual silence, the running window's occurrence, and this morning's weekly one. */
export const silencesWithWindows: ReadonlyArray<V2AlertSilence> = [
	silenceOf(1, {
		reason: "Deploying payments v2.3",
		startMin: -10,
		endMin: 50,
		matchers: { services: ["payments"] },
	}),
	silenceOf(2, {
		reason: "Maintenance: Checkout v3 migration",
		startMin: -30,
		endMin: 90,
		window: runningWindow,
	}),
	silenceOf(4, {
		reason: "Maintenance: Nightly database backup (Snapshot and vacuum)",
		startMin: -(12 * 60),
		endMin: -(10 * 60),
		window: weeklyWindow,
	}),
]
