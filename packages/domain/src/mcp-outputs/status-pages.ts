import { Schema } from "effect"
import { StatusPageConfig } from "../http/v2/status-pages"
import {
	StatusPageAutoIncidents,
	StatusPageComponentStatus,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
} from "../primitives"

// ---------------------------------------------------------------------------------------------
// list_status_pages / get_status_page / create_status_page_incident / post_status_page_update /
// resolve_status_page_incident / schedule_status_page_maintenance

export const StatusPageRow = Schema.Struct({
	/** REST id (`stp_…`). */
	id: Schema.String,
	name: Schema.String,
	slug: Schema.String,
	autoIncidents: StatusPageAutoIncidents,
	revision: Schema.Number,
	publishedRevision: Schema.Number,
	/** ISO timestamp of the last publish; null before the first one. */
	publishedAt: Schema.NullOr(Schema.String),
	lastPublishError: Schema.NullOr(Schema.String),
})

export const ListStatusPagesOutput = Schema.Struct({
	pages: Schema.Array(StatusPageRow),
	total: Schema.Number,
})

export const StatusPageComponentRow = Schema.Struct({
	/** REST id (`stc_…`). */
	id: Schema.String,
	name: Schema.String,
	group: Schema.NullOr(Schema.String),
	/** What visitors see: the worst of the monitor, the manual override and published incidents. */
	status: StatusPageComponentStatus,
	/** REST id of the linked uptime monitor (`upm_…`), or null. */
	monitorId: Schema.NullOr(Schema.String),
	manualStatus: Schema.NullOr(StatusPageComponentStatus),
})

export const StatusPageIncidentUpdateRow = Schema.Struct({
	status: StatusPageIncidentStatus,
	body: Schema.String,
	at: Schema.String,
})

export const StatusPageIncidentRow = Schema.Struct({
	/** REST id (`sti_…`). */
	id: Schema.String,
	/** REST id of the page (`stp_…`). */
	pageId: Schema.String,
	kind: StatusPageIncidentKind,
	title: Schema.String,
	impact: StatusPageIncidentImpact,
	status: StatusPageIncidentStatus,
	/** Drafts are not on the page until published. */
	published: Schema.Boolean,
	startedAt: Schema.String,
	resolvedAt: Schema.NullOr(Schema.String),
	scheduledStart: Schema.NullOr(Schema.String),
	scheduledEnd: Schema.NullOr(Schema.String),
	componentIds: Schema.Array(Schema.String),
	latestUpdate: Schema.NullOr(StatusPageIncidentUpdateRow),
	updateCount: Schema.Number,
})

export const StatusPageFreshnessRow = Schema.Struct({
	/** `delayed` when the page's monitors have not reported in the last minutes. */
	state: Schema.Literals(["live", "delayed"]),
	/** When the page's state was last confirmed by a check result; null when its monitors never reported lately. */
	updatedAt: Schema.NullOr(Schema.String),
	/** Whether a change is still waiting for the next publish. */
	publishPending: Schema.Boolean,
})

export const GetStatusPageOutput = Schema.Struct({
	page: StatusPageRow,
	/** The banner: the worst component status. */
	overallStatus: StatusPageComponentStatus,
	components: Schema.Array(StatusPageComponentRow),
	/** Open incidents and maintenance not yet completed, drafts included; newest first. */
	activeIncidents: Schema.Array(StatusPageIncidentRow),
	freshness: StatusPageFreshnessRow,
})

export const StatusPageIncidentMutationOutput = Schema.Struct({
	action: Schema.Literals(["created", "updated", "resolved", "scheduled"]),
	incident: StatusPageIncidentRow,
})

// ---------------------------------------------------------------------------------------------
// get_status_page_config / apply_status_page_config

export const GetStatusPageConfigOutput = Schema.Struct({
	page: StatusPageRow,
	/** The document `PUT /v2/status_pages/{id}/config` and apply_status_page_config take. */
	config: StatusPageConfig,
})

const StatusPageConfigChangesRow = Schema.Struct({
	/** Page fields whose value changed. */
	fields: Schema.Array(Schema.String),
	/** Component names, as listed in the applied config. */
	created: Schema.Array(Schema.String),
	updated: Schema.Array(Schema.String),
	deleted: Schema.Array(Schema.String),
	reordered: Schema.Boolean,
})

export const ApplyStatusPageConfigOutput = Schema.Struct({
	page: StatusPageRow,
	config: StatusPageConfig,
	changes: StatusPageConfigChangesRow,
})
