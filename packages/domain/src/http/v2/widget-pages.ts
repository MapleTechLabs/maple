import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { OrgId } from "@maple/primitives"
import {
	AlertIncidentNotFoundError,
	AlertIncidentResolvedError,
	AlertPersistenceError,
	AlertSeverity,
} from "../alerts"
import { EndpointAccess, requires } from "../endpoint-access"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { publicError } from "./public-error"
import { AlertIncidentPublicId } from "./resource-ids"

/**
 * What the iOS Pages widget draws and does: the open incidents paging the person the credential
 * belongs to, and acknowledging one of them.
 *
 * Under `/v2/widget_summary` on purpose. A device credential's scope is derived from the first path
 * segment, so `widget_summary:read` reaches the list and `widget_summary:write` the acknowledgement,
 * and neither reaches anything else under `/v2/alerts`. See `widget-summary.ts` for the fence.
 *
 * Values arrive formatted. The widget extension carries no unit logic, and two builds formatting a
 * threshold differently would show one incident two ways.
 */

/** A Home Screen widget draws two rows at most; the rest is a count. */
export const WIDGET_PAGES_LIMIT = 10

export const V2WidgetPage = Schema.Struct({
	incident_id: AlertIncidentPublicId,
	rule_name: Schema.String,
	group: Schema.NullOr(Schema.String).annotate({
		description: "The group or service that breached, or `null` for an ungrouped rule.",
	}),
	severity: AlertSeverity,
	value: Schema.String.annotate({
		description: "The last observed value, formatted in the signal's unit.",
		examples: ["9.1%"],
	}),
	threshold: Schema.String.annotate({
		description: "The comparison it breached, in the same unit.",
		examples: ["> 5%"],
	}),
	opened_at: Timestamp,
	acknowledged_by: Schema.NullOr(Schema.String).annotate({
		description: "Who acknowledged the incident, as a name to show, or `null` while nobody has.",
	}),
	acknowledged_by_you: Schema.Boolean.annotate({
		description: "Whether the acknowledgement is the calling user's own.",
	}),
	next_page_at: Schema.NullOr(Timestamp).annotate({
		description: "When the next escalation step pages, or `null` when no step is waiting.",
	}),
	next_page_people: Schema.NullOr(Schema.String).annotate({
		description: "Who that step pages, as a short label, or `null` when it names nobody.",
		examples: ["Priya Shah +1"],
	}),
}).annotate({
	identifier: "WidgetPage",
	title: "Widget page",
	description: "One open incident that paged the calling user, reduced to what a widget row draws.",
})
export type V2WidgetPage = Schema.Schema.Type<typeof V2WidgetPage>

export const V2WidgetPages = Schema.Struct({
	object: Schema.Literal("widget_pages").annotate({
		description: 'The object type, always `"widget_pages"`.',
	}),
	generated_at: Timestamp,
	organization_id: OrgId,
	has_more: Schema.Boolean.annotate({
		description:
			"More unacknowledged incidents are paging the user than `data` carries, so a count of them is a floor. Acknowledged incidents left out do not set it.",
	}),
	data: Schema.Array(V2WidgetPage),
}).annotate({
	identifier: "WidgetPages",
	title: "Widget pages",
	description:
		"The open incidents paging the calling user: the unacknowledged ones first, then most recently triggered.",
	examples: [
		wireExample({
			object: "widget_pages",
			generated_at: "2026-11-27T01:14:00.000Z",
			organization_id: "org_2abcDEF",
			has_more: false,
			data: [
				{
					incident_id: "inc_tC4d9V79DCDzgbGKhAnff9",
					rule_name: "Checkout error rate",
					group: "checkout-api",
					severity: "critical",
					value: "9.1%",
					threshold: "> 5%",
					opened_at: "2026-11-27T01:12:00.000Z",
					acknowledged_by: null,
					acknowledged_by_you: false,
					next_page_at: "2026-11-27T01:19:00.000Z",
					next_page_people: "Priya Shah",
				},
			],
		}),
	],
})
export type V2WidgetPages = Schema.Schema.Type<typeof V2WidgetPages>

const alertPersistence = publicError(AlertPersistenceError)

export class V2WidgetPagesApiGroup extends HttpApiGroup.make("widgetPages")
	.add(
		HttpApiEndpoint.get("list", "/", {
			success: V2WidgetPages,
			error: [alertPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listWidgetPages",
				summary: "List the incidents paging you, for a widget",
				description:
					"Returns the open incidents an escalation step paged the calling user for, sized and formatted for a Home Screen widget. Requires the `widget_summary:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("acknowledge", "/:id/acknowledge", {
			params: { id: AlertIncidentPublicId },
			success: V2WidgetPage,
			error: [
				publicError(AlertIncidentNotFoundError),
				publicError(AlertIncidentResolvedError),
				alertPersistence,
			],
		})
			.annotate(EndpointAccess, requires("incidents:respond"))
			.annotateMerge(
				OpenApi.annotations({
					identifier: "acknowledgeWidgetPage",
					summary: "Acknowledge an incident from a widget",
					description:
						"Acknowledges an open incident that paged the calling user, as `POST /v2/alerts/incidents/{id}/acknowledge` does, and returns the widget row as it now stands. Fails with 404 on an incident that did not page the caller and 409 on a resolved one. Requires the `widget_summary:write` scope.",
				}),
			),
	)
	.prefix("/v2/widget_summary/pages")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Widget Pages",
			description:
				"What the Maple mobile Pages widget reads and does. In the widget's own scope family so a device credential can acknowledge without reaching the rest of the alerts API.",
		}),
	)
	.annotate(EndpointAccess, requires("telemetry:read")) {}
