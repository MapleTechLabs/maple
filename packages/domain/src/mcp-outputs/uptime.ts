import { Schema } from "effect"
import { UptimeMonitorKind, UptimeMonitorStatus } from "../primitives"

// ---------------------------------------------------------------------------------------------
// list_uptime_monitors / create_uptime_monitor / update_uptime_monitor / delete_uptime_monitor

export const UptimeMonitorLastCheckRow = Schema.Struct({
	at: Schema.String,
	ok: Schema.Boolean,
	statusCode: Schema.NullOr(Schema.Number),
	durationMs: Schema.NullOr(Schema.Number),
	/** One sentence, e.g. `Status 503, expected 2xx`; null when the check passed. */
	error: Schema.NullOr(Schema.String),
	/** The check's own span in the org's traces (http/tcp/dns); null for heartbeats. */
	traceId: Schema.NullOr(Schema.String),
})

export const UptimeMonitorRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	kind: UptimeMonitorKind,
	/** What is checked, in one line: `GET https://…`, `db.example.com:5432`, `A example.com`, a schedule. */
	target: Schema.String,
	status: UptimeMonitorStatus,
	enabled: Schema.Boolean,
	serviceName: Schema.NullOr(Schema.String),
	intervalSeconds: Schema.Number,
	failuresToDown: Schema.Number,
	statusChangedAt: Schema.NullOr(Schema.String),
	lastCheck: Schema.NullOr(UptimeMonitorLastCheckRow),
	/** Share of the recent checks that passed, 0 to 1; null before the first check. */
	uptimeRatio: Schema.NullOr(Schema.Number),
	recentChecks: Schema.Number,
	lastPingAt: Schema.NullOr(Schema.String),
	/** Heartbeats only: the URL the job pings. */
	heartbeatUrl: Schema.NullOr(Schema.String),
	destinationIds: Schema.Array(Schema.String),
})

export const ListUptimeMonitorsOutput = Schema.Struct({
	monitors: Schema.Array(UptimeMonitorRow),
	total: Schema.Number,
	/** Counts over every monitor, before the filters. */
	counts: Schema.Struct({
		up: Schema.Number,
		down: Schema.Number,
		pending: Schema.Number,
		paused: Schema.Number,
	}),
	statusFilter: Schema.optionalKey(UptimeMonitorStatus),
	serviceFilter: Schema.optionalKey(Schema.String),
})

export const UptimeMonitorMutationOutput = Schema.Struct({
	action: Schema.Literals(["created", "updated"]),
	monitor: UptimeMonitorRow,
	/** Heartbeats only: a shell line that pings the monitor, for the job's last step. */
	pingCommand: Schema.NullOr(Schema.String),
})

export const DeleteUptimeMonitorOutput = Schema.Struct({
	deleted: Schema.Boolean,
	id: Schema.String,
	name: Schema.String,
})
