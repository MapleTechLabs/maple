import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { RETENTION_PERIODS, RetentionDays } from "../../retention"
import { RetentionInvalidError, RetentionOwnWarehouseError, RetentionPersistenceError } from "../retention"
import { SourceNotFoundError } from "../sources"
import { EndpointAccess, requires } from "../endpoint-access"
import { V2InsufficientPermissions } from "./errors"
import { AuthorizationV2 } from "./auth"
import { wireExample } from "./envelopes"
import { publicError } from "./public-error"
import { SourcePublicId } from "./sources"

const daysField = (signal: string) =>
	Schema.Int.annotate({ description: `Days ${signal} are kept.`, examples: [30] })

/** What each signal resolves to: every signal, always present. */
export const V2RetentionDays = Schema.Struct({
	traces: daysField("spans"),
	logs: daysField("log records"),
	metrics: daysField("metric data points"),
	sessions: daysField("session replays"),
	events: daysField("product events"),
	profiles: daysField("profiles"),
}).annotate({ identifier: "RetentionDays", title: "Retention days" })
export type V2RetentionDays = typeof V2RetentionDays.Type

const setField = (inherits: string) =>
	Schema.NullOr(RetentionDays).annotate({
		description: `The period set here, or \`null\` to keep ${inherits}.`,
		examples: [90, null],
	})

const setFields = (inherits: string) => ({
	traces: setField(inherits),
	logs: setField(inherits),
	metrics: setField(inherits),
	sessions: setField(inherits),
	events: setField(inherits),
	profiles: setField(inherits),
})

export const V2RetentionSource = Schema.Struct({
	source_id: SourcePublicId,
	set: Schema.Struct(setFields("the organization's period")).annotate({
		identifier: "SourceRetentionSet",
		title: "Source retention set",
	}),
	days: V2RetentionDays,
}).annotate({
	identifier: "SourceRetention",
	title: "Source retention",
	description: "A source that keeps at least one signal for a period of its own.",
})

export const V2RetentionStorage = Schema.Literals(["managed", "own_warehouse"]).annotate({
	description:
		"Where the organization's telemetry is stored. `own_warehouse` keeps the retention set in that ClickHouse, and these periods do not apply.",
})

export const V2RetentionPolicy = Schema.Struct({
	object: Schema.Literal("retention_policy"),
	storage: V2RetentionStorage,
	periods: Schema.Array(RetentionDays).annotate({
		description: "The periods a signal can be kept for, in days.",
	}),
	defaults: V2RetentionDays.annotate({ description: "What a signal keeps when nothing is set." }),
	organization: Schema.Struct({
		set: Schema.Struct(setFields("the default")).annotate({
			identifier: "OrganizationRetentionSet",
			title: "Organization retention set",
		}),
		days: V2RetentionDays,
	}).annotate({ description: "What the organization set, and what a source that sets nothing keeps." }),
	read_horizon_days: V2RetentionDays.annotate({
		description: "How far back reads reach per signal: the longest any source keeps it.",
	}),
	sources: Schema.Array(V2RetentionSource),
}).annotate({
	identifier: "RetentionPolicy",
	title: "Retention policy",
	description:
		"How long the organization keeps each signal, and the sources that keep a signal for a period of their own.",
	examples: [
		wireExample({
			object: "retention_policy",
			storage: "managed",
			periods: [...RETENTION_PERIODS],
			defaults: { traces: 30, logs: 30, metrics: 90, sessions: 30, events: 365, profiles: 14 },
			organization: {
				set: { traces: null, logs: 90, metrics: null, sessions: null, events: null, profiles: null },
				days: { traces: 30, logs: 90, metrics: 90, sessions: 30, events: 365, profiles: 14 },
			},
			read_horizon_days: {
				traces: 30,
				logs: 180,
				metrics: 90,
				sessions: 30,
				events: 365,
				profiles: 14,
			},
			sources: [
				{
					source_id: "src_4CzLmR8kTq",
					set: {
						traces: null,
						logs: 180,
						metrics: null,
						sessions: null,
						events: null,
						profiles: null,
					},
					days: { traces: 30, logs: 180, metrics: 90, sessions: 30, events: 365, profiles: 14 },
				},
			],
		}),
	],
})
export type V2RetentionPolicy = typeof V2RetentionPolicy.Type

const patchField = (inherits: string) =>
	Schema.optionalKey(
		Schema.NullOr(RetentionDays).annotate({
			description: `Days to keep, or \`null\` to keep ${inherits}. Omitted is unchanged.`,
		}),
	)

const patchFields = (inherits: string) => ({
	traces: patchField(inherits),
	logs: patchField(inherits),
	metrics: patchField(inherits),
	sessions: patchField(inherits),
	events: patchField(inherits),
	profiles: patchField(inherits),
})

export const V2RetentionUpdateParams = Schema.Struct(patchFields("the default")).annotate({
	identifier: "RetentionUpdateParams",
	title: "Update retention",
})
export type V2RetentionUpdateParams = typeof V2RetentionUpdateParams.Type

export const V2SourceRetentionUpdateParams = Schema.Struct(patchFields("the organization's period")).annotate(
	{
		identifier: "SourceRetentionUpdateParams",
		title: "Update a source's retention",
	},
)
export type V2SourceRetentionUpdateParams = typeof V2SourceRetentionUpdateParams.Type

const persistence = publicError(RetentionPersistenceError)
const invalid = publicError(RetentionInvalidError)
const ownWarehouse = publicError(RetentionOwnWarehouseError)

const WRITE_NOTE =
	"Data keeps the period in force when it arrived. Once an organization has set any period, reads of every signal reach back as far as the longest period any source keeps it, the default included: a shorter period (or going back to a shorter default) hides older data unless another source keeps it longer, and a longer one applies to data received from about a minute after the change, once the ingest gateway reads the new policy. Session replays and product events keep their default for now: setting either is refused with `retention_invalid` (400). A patch that changes nothing writes nothing. Refused with `retention_own_warehouse` (409) for an organization on its own ClickHouse. Requires the `retention:write` scope and the Manage retention permission."

export class V2RetentionApiGroup extends HttpApiGroup.make("retention")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			success: V2RetentionPolicy,
			error: [V2InsufficientPermissions.schema, persistence],
		})
			// Not telemetry: a role limited to namespaces reads it too. The handler asks for either read.
			.annotate(EndpointAccess, "personal")
			.annotateMerge(
				OpenApi.annotations({
					identifier: "getRetention",
					summary: "Retrieve retention",
					description:
						"Returns how long the organization keeps each signal, and every source that sets a period of its own. Requires the `retention:read` scope and a telemetry read permission, all telemetry or namespace-limited.",
				}),
			),
	)
	.add(
		HttpApiEndpoint.patch("update", "/", {
			payload: V2RetentionUpdateParams,
			success: V2RetentionPolicy,
			error: [invalid, ownWarehouse, persistence],
		})
			.annotate(EndpointAccess, requires("retention:manage"))
			.annotateMerge(
				OpenApi.annotations({
					identifier: "updateRetention",
					summary: "Update retention",
					description: `Sets how long the organization keeps each signal. ${WRITE_NOTE}`,
				}),
			),
	)
	.add(
		HttpApiEndpoint.patch("updateSource", "/sources/:id", {
			params: { id: SourcePublicId },
			payload: V2SourceRetentionUpdateParams,
			success: V2RetentionPolicy,
			error: [invalid, ownWarehouse, publicError(SourceNotFoundError), persistence],
		})
			.annotate(EndpointAccess, requires("retention:manage"))
			.annotateMerge(
				OpenApi.annotations({
					identifier: "updateSourceRetention",
					summary: "Update a source's retention",
					description: `Sets how long one source keeps each signal, shorter or longer than the organization. ${WRITE_NOTE}`,
				}),
			),
	)
	.prefix("/v2/retention")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Retention",
			description:
				"How long Maple keeps traces, logs, metrics, session replays, product events and profiles, for the organization and per source.",
		}),
	) {}
