import { Schema } from "effect"
import { StatusPageConfig } from "../http/v2/status-pages"
import { StatusPageCustomDomainDnsRecord } from "../status-page"
import {
	StatusPageAutoIncidents,
	StatusPageComponentStatus,
	StatusPageCustomDomainStatus,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
	StatusPageVisibility,
} from "@maple/primitives"

export const StatusPageRow = Schema.Struct({
	/** REST id (`stp_…`). */
	id: Schema.String,
	name: Schema.String,
	slug: Schema.String,
	autoIncidents: StatusPageAutoIncidents,
	/** `password` pages need a password at the edge; `internal` ones are only shown inside Maple. */
	visibility: StatusPageVisibility,
	/** A draft is not public until it is published. */
	draft: Schema.Boolean,
	revision: Schema.Number,
	publishedRevision: Schema.Number,
	/** ISO timestamp of the last publish; null before the first one. */
	publishedAt: Schema.NullOr(Schema.String),
	lastPublishError: Schema.NullOr(Schema.String),
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
	/** Maintenance only: completes itself when its window ends. */
	autoComplete: Schema.Boolean,
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

/** A page's custom domain and how far its setup has come. */
export const StatusPageDomainRow = Schema.Struct({
	hostname: Schema.String,
	/** `pending_dns` until the records below are found, `pending_ssl` until the certificate is issued. */
	status: StatusPageCustomDomainStatus,
	/** What to add at the domain's DNS provider: the CNAME, and TXT records while they are needed. */
	dnsRecords: Schema.Array(StatusPageCustomDomainDnsRecord),
	/** Why the last check did not finish the setup; null when nothing is wrong. */
	lastError: Schema.NullOr(Schema.String),
	lastCheckedAt: Schema.NullOr(Schema.String),
	activatedAt: Schema.NullOr(Schema.String),
})

/** One page as its visitors see it. */
export const StatusPageDetail = Schema.Struct({
	...StatusPageRow.fields,
	/** The page's own domain (`status.acme.com`); absent when it has none. */
	customDomain: Schema.optionalKey(StatusPageDomainRow),
	/** The banner: the worst component status. */
	overallStatus: StatusPageComponentStatus,
	components: Schema.Array(StatusPageComponentRow),
	/** Open incidents and maintenance not yet completed, drafts included; newest first. */
	activeIncidents: Schema.Array(StatusPageIncidentRow),
	freshness: StatusPageFreshnessRow,
})

export const GetStatusPageOutput = Schema.Struct({
	/** Every page of the org, when no `page` was asked for. */
	pages: Schema.optionalKey(Schema.Array(StatusPageRow)),
	page: Schema.optionalKey(StatusPageDetail),
	/** With include_config: the document `PUT /v2/status_pages/{id}/config` and apply_status_page_config take. */
	config: Schema.optionalKey(StatusPageConfig),
})

export const StatusPageIncidentMutationOutput = Schema.Struct({
	action: Schema.Literals(["created", "updated", "resolved", "scheduled"]),
	incident: StatusPageIncidentRow,
	/** The incident's page is a draft: nothing on it is public, a published incident included. */
	pageDraft: Schema.Boolean,
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

export const CreateStatusPageOutput = Schema.Struct({
	/** Always a draft: private until publish_status_page. */
	page: StatusPageRow,
})

export const PublishStatusPageOutput = Schema.Struct({
	/** `already_public` when the page was not a draft: nothing changed. */
	action: Schema.Literals(["published", "already_public"]),
	page: StatusPageRow,
})

export const SetStatusPageDomainOutput = Schema.Struct({
	/** `set` a new domain, `checked` the page's current one again, `removed` it, or `unchanged` (none to remove). */
	action: Schema.Literals(["set", "checked", "removed", "unchanged"]),
	page: StatusPageRow,
	/** Null once removed. */
	domain: Schema.NullOr(StatusPageDomainRow),
})
