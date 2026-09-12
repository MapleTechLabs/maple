import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	IntegrationReturnPath,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsRevokedError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
} from "../integrations"
import { AuthorizationV2 } from "./auth"
import { Timestamp, wireExample } from "./envelopes"
import { V2CallbackHostUnavailable, V2InsufficientPermissions } from "./errors"
import { publicErrors } from "./public-error"

// Google Analytics 4 integration. An org connects a Google account over OAuth,
// Maple discovers every GA4 property that grant can see, and a cron collects each
// property's hourly numbers into the regular OTel metrics pipeline.
//
// v2 from the start rather than promoted from v1: PlanetScale and Slack are the
// most recent integrations and both live here, and the dashboard is migrating
// off the v1 client.

export const V2GoogleAnalyticsProperty = Schema.Struct({
	object: Schema.Literal("google_analytics_property").annotate({
		description: 'The object type — always `"google_analytics_property"`.',
		examples: ["google_analytics_property"],
	}),
	property_id: Schema.String.annotate({
		description: "The GA4 property ID, without the API's `properties/` resource prefix.",
		examples: ["123456789"],
	}),
	property_name: Schema.NullOr(Schema.String).annotate({
		description: "The property's display name in Google Analytics.",
		examples: ["example.com — GA4"],
	}),
	account_name: Schema.NullOr(Schema.String).annotate({
		description: "The Google Analytics account the property belongs to.",
		examples: ["Acme Inc"],
	}),
	time_zone: Schema.NullOr(Schema.String).annotate({
		description:
			"The property's IANA reporting timezone. Google reports hourly data in this zone, so Maple resolves it before collecting anything; `null` means it has not been resolved yet and the property is not being collected.",
		examples: ["America/Los_Angeles"],
	}),
	enabled: Schema.Boolean.annotate({
		description: "Whether Maple collects this property. Newly discovered properties start enabled.",
		examples: [true],
	}),
	last_synced_at: Schema.NullOr(Timestamp).annotate({
		description: "When collection last succeeded for every one of this property's report types.",
	}),
	last_error: Schema.NullOr(Schema.String).annotate({
		description: "The most recent collection error for this property, if any.",
		examples: ["Google Analytics Data API quota exhausted (429 RESOURCE_EXHAUSTED)"],
	}),
	watermark_at: Schema.NullOr(Timestamp).annotate({
		description: "End of the newest hour collected.",
	}),
	backfill_at: Schema.NullOr(Timestamp).annotate({
		description:
			"Oldest hour the history backfill has reached, walking backwards. Backfill is complete once this stops moving.",
	}),
}).annotate({
	identifier: "GoogleAnalyticsProperty",
	title: "Google Analytics property",
	description: "One GA4 property discovered under the connected Google account.",
})
export type V2GoogleAnalyticsProperty = Schema.Schema.Type<typeof V2GoogleAnalyticsProperty>

export const V2GoogleAnalyticsIntegration = Schema.Struct({
	object: Schema.Literal("google_analytics_integration").annotate({
		description: 'The object type — always `"google_analytics_integration"`.',
		examples: ["google_analytics_integration"],
	}),
	connected: Schema.Boolean.annotate({
		description: "Whether a Google account is currently connected.",
		examples: [true],
	}),
	connected_at: Schema.NullOr(Timestamp).annotate({
		description: "When the connection was established.",
	}),
	connected_email: Schema.NullOr(Schema.String).annotate({
		description: "The Google account the grant belongs to.",
		examples: ["analytics@example.com"],
	}),
	revoked: Schema.Boolean.annotate({
		description:
			"True when Google rejected the stored grant. Collection stops until someone reconnects; nothing already collected is lost.",
		examples: [false],
	}),
	properties: Schema.Array(V2GoogleAnalyticsProperty).annotate({
		description: "Every GA4 property discovered under the grant, ordered by property ID.",
	}),
}).annotate({
	identifier: "GoogleAnalyticsIntegration",
	title: "Google Analytics integration",
	description: "The Google Analytics connection state for your organization.",
})
export type V2GoogleAnalyticsIntegration = Schema.Schema.Type<typeof V2GoogleAnalyticsIntegration>

export const V2GoogleAnalyticsConnectRequest = Schema.Struct({
	return_to: Schema.optionalKey(IntegrationReturnPath).annotate({
		description:
			"Relative path in the Maple dashboard to send the user back to after the callback completes — absolute URLs are rejected. Ignored for headless callers.",
	}),
}).annotate({
	identifier: "GoogleAnalyticsConnectRequest",
	title: "Google Analytics connect request",
	description: "Options for beginning a Google OAuth authorization.",
	examples: [wireExample({ return_to: "/integrations" })],
})
export type V2GoogleAnalyticsConnectRequest = Schema.Schema.Type<typeof V2GoogleAnalyticsConnectRequest>

export const V2GoogleAnalyticsConnectResponse = Schema.Struct({
	object: Schema.Literal("google_analytics_integration.connect").annotate({
		description: 'The object type — always `"google_analytics_integration.connect"`.',
		examples: ["google_analytics_integration.connect"],
	}),
	redirect_url: Schema.String.annotate({
		description:
			"The Google authorize URL to send the user to. Opens Google's consent screen; on approval Google redirects back to Maple's callback.",
		examples: ["https://accounts.google.com/o/oauth2/v2/auth?client_id=..."],
	}),
	state: Schema.String.annotate({
		description: "The opaque OAuth state parameter embedded in `redirect_url`.",
		examples: ["b4f1c0e2"],
	}),
}).annotate({
	identifier: "GoogleAnalyticsConnectResponse",
	title: "Google Analytics connect response",
	description: "Where to send the user to authorize Google Analytics.",
})
export type V2GoogleAnalyticsConnectResponse = Schema.Schema.Type<typeof V2GoogleAnalyticsConnectResponse>

export const V2GoogleAnalyticsDisconnectResponse = Schema.Struct({
	object: Schema.Literal("google_analytics_integration.disconnect").annotate({
		description: 'The object type — always `"google_analytics_integration.disconnect"`.',
		examples: ["google_analytics_integration.disconnect"],
	}),
	disconnected: Schema.Boolean.annotate({
		description: "True when a connection was removed; false when there was nothing to remove.",
		examples: [true],
	}),
}).annotate({
	identifier: "GoogleAnalyticsDisconnectResponse",
	title: "Google Analytics disconnect response",
})
export type V2GoogleAnalyticsDisconnectResponse = Schema.Schema.Type<
	typeof V2GoogleAnalyticsDisconnectResponse
>

export const V2GoogleAnalyticsPrimeResponse = Schema.Struct({
	object: Schema.Literal("google_analytics_integration.prime").annotate({
		description: 'The object type — always `"google_analytics_integration.prime"`.',
		examples: ["google_analytics_integration.prime"],
	}),
	properties: Schema.Number.annotate({
		description: "How many properties the poll touched.",
		examples: [2],
	}),
	rows_ingested: Schema.Number.annotate({
		description: "How many metric data points the poll wrote.",
		examples: [412],
	}),
}).annotate({
	identifier: "GoogleAnalyticsPrimeResponse",
	title: "Google Analytics prime response",
	description: "Result of the bounded first collection run after connecting.",
})
export type V2GoogleAnalyticsPrimeResponse = Schema.Schema.Type<typeof V2GoogleAnalyticsPrimeResponse>

export const V2GoogleAnalyticsPropertyUpdateParams = Schema.Struct({
	enabled: Schema.Boolean.annotate({
		description: "Whether Maple should collect this property.",
		examples: [false],
	}),
}).annotate({
	identifier: "GoogleAnalyticsPropertyUpdateParams",
	title: "Google Analytics property update",
	examples: [wireExample({ enabled: false })],
})
export type V2GoogleAnalyticsPropertyUpdateParams = Schema.Schema.Type<
	typeof V2GoogleAnalyticsPropertyUpdateParams
>

const [
	integrationNotConnected,
	integrationRevoked,
	integrationValidation,
	integrationUpstream,
	integrationPersistence,
] = publicErrors(
	IntegrationsNotConnectedError,
	IntegrationsRevokedError,
	IntegrationsValidationError,
	IntegrationsUpstreamError,
	IntegrationsPersistenceError,
)

const connectionErrors = [
	integrationNotConnected,
	integrationRevoked,
	integrationValidation,
	integrationUpstream,
	integrationPersistence,
] as const

export class V2GoogleAnalyticsIntegrationsApiGroup extends HttpApiGroup.make("googleAnalyticsIntegration")
	.add(
		HttpApiEndpoint.get("status", "/", {
			success: V2GoogleAnalyticsIntegration,
			error: [integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getGoogleAnalyticsIntegration",
				summary: "Retrieve Google Analytics integration status",
				description:
					"Returns the Google Analytics connection state for your organization and the collection health of every GA4 property under the grant. Requires the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("connect", "/connect", {
			payload: V2GoogleAnalyticsConnectRequest,
			// No upstream error: nothing reaches Google until the browser follows
			// the returned authorize URL.
			success: V2GoogleAnalyticsConnectResponse,
			error: [
				V2InsufficientPermissions.schema,
				V2CallbackHostUnavailable.schema,
				integrationValidation,
				integrationPersistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "connectGoogleAnalyticsIntegration",
				summary: "Begin a Google Analytics connection",
				description:
					"Returns a Google OAuth authorize URL to redirect the user to. Browser-oriented: a headless caller cannot complete the redirect, so scripted setups should connect once from the dashboard. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("disconnect", "/", {
			success: V2GoogleAnalyticsDisconnectResponse,
			error: [V2InsufficientPermissions.schema, integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "disconnectGoogleAnalyticsIntegration",
				summary: "Disconnect Google Analytics",
				description:
					"Revokes the grant at Google and removes the connection along with all collection state. Metrics already collected are retained and age out with your normal retention. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("prime", "/prime", {
			success: V2GoogleAnalyticsPrimeResponse,
			error: [V2InsufficientPermissions.schema, ...connectionErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "primeGoogleAnalyticsIntegration",
				summary: "Run a Google Analytics collection now",
				description:
					"Runs one bounded collection pass immediately instead of waiting for the next scheduled run, so a freshly connected property shows data right away. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("updateProperty", "/properties/:property_id", {
			params: { property_id: Schema.String },
			payload: V2GoogleAnalyticsPropertyUpdateParams,
			success: V2GoogleAnalyticsIntegration,
			error: [V2InsufficientPermissions.schema, integrationPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateGoogleAnalyticsProperty",
				summary: "Enable or disable a Google Analytics property",
				description:
					"Turns collection on or off for one GA4 property. Disabling stops collection but keeps the property's position, so re-enabling resumes from where it left off rather than re-collecting history. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.prefix("/v2/integrations/google_analytics")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Google Analytics Integration",
			description:
				"Connect Google Analytics 4 to your organization and manage what Maple collects from it: connection status, the properties discovered under the grant, and which of them are collected. Collected data lands as regular metrics, so it charts and alerts alongside your traces.",
		}),
	) {}
