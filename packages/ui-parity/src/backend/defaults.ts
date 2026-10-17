import { detectAiModel } from "@maple/ai-model-catalog"
import { Effect, Schema } from "effect"
import {
	DetectAiModelsRequest,
	SelfHostedAuthDisabledError,
	SelfHostedInvalidPasswordError,
	UnauthorizedError,
} from "@maple/domain/http"
import type { Dataset, EndpointHandler } from "../fixtures/dataset.ts"
import { DAY } from "../fixtures/identity.ts"
import { fixtureSession } from "./auth.ts"

/**
 * Generic answers for the endpoints every core route hits on load, in wire form. A dataset's own
 * `endpoints` win over these. Anything in neither is unmocked and fails the capture.
 * Writes the app fires on its own belong here too, answered without changing any fixture data.
 */

const emptyList = { object: "list", data: [], has_more: false, next_cursor: null }

const session = (dataset: Dataset) => {
	const identity = dataset.identity
	return identity === null
		? undefined
		: {
				orgId: identity.orgId,
				userId: identity.userId,
				roles: dataset.auth === "self_hosted" ? ["root"] : [identity.role === "admin" ? "org:admin" : "org:member"],
				authMode: dataset.auth,
			}
}

const login: EndpointHandler = ({ dataset }) => {
	if (dataset.auth !== "self_hosted")
		return Effect.fail(new SelfHostedAuthDisabledError({ message: "Self-hosted login is disabled" }))
	const minted = fixtureSession(dataset)
	if (minted === undefined || dataset.identity === null)
		return Effect.fail(new SelfHostedInvalidPasswordError({ message: "Invalid password" }))
	return Effect.succeed({
		token: minted.token,
		orgId: dataset.identity.orgId,
		userId: dataset.identity.userId,
		expiresAt: minted.expiresAt,
		sessionExpiresAt: minted.sessionExpiresAt,
	})
}

const sessionRefresh: EndpointHandler = (request) =>
	request.dataset.identity === null
		? Effect.fail(new UnauthorizedError({ message: "Invalid or missing credentials." }))
		: login(request)

const disconnectedCloudflare = {
	connected: false,
	accountId: null,
	accountName: null,
	connectedByUserId: null,
	scope: null,
	analyticsCapable: false,
	connectedAt: null,
	accounts: [],
	zones: [],
	workers: null,
}

const disconnectedRailway = {
	connected: false,
	workspaceNames: null,
	connectedByUserId: null,
	connectedAt: null,
	authFailed: false,
	lastSyncedAt: null,
	lastError: null,
	environments: [],
}

const disconnectedPlanetScale = {
	object: "planetscale_integration",
	connected: false,
	pending_org_selection: false,
	organization: null,
	connected_by_user_id: null,
	detected_permissions: null,
	metrics_auth: "missing",
	scrape_target: null,
	last_inventory_at: null,
	last_inventory_error: null,
	revoked_at: null,
	expires_at: null,
}

/** A Startup subscription, so plan-gated settings render their unlocked state. */
const billingCustomer: EndpointHandler = ({ dataset }) =>
	Effect.succeed({
		id: dataset.identity?.orgId ?? "org_parity_signed_out",
		subscriptions: [{ planId: "startup", status: "active", currentPeriodStart: Date.parse(dataset.now) - 10 * DAY, currentPeriodEnd: Date.parse(dataset.now) + 20 * DAY }],
	})

/** Fixed fake keys: the settings page shows them masked, and they must not change run to run. */
const ingestKeys: EndpointHandler = ({ dataset }) =>
	Effect.succeed({
		object: "ingest_keys",
		public_key: `maple_pk_parity_${dataset.name}`,
		private_key: `maple_sk_parity_${dataset.name}`,
		public_rotated_at: new Date(Date.parse(dataset.now) - 30 * DAY).toISOString(),
		private_rotated_at: new Date(Date.parse(dataset.now) - 30 * DAY).toISOString(),
	})


// The real catalog lookup the API runs (`apps/api/src/routes/internal/ai-models.http.ts`).
const detectAiModels: EndpointHandler = ({ payload }) =>
	Effect.map(Schema.decodeUnknownEffect(DetectAiModelsRequest)(payload), (request) =>
		request.models.map((model) => detectAiModel(model)),
	)
const constant =
	(value: unknown): EndpointHandler =>
	() =>
		Effect.succeed(value)

/** Defaults keyed `"<group>.<endpoint>"`; `queryEngine.executeBatch` is wired by the server itself. */
export const defaultHandlers = new Map<string, EndpointHandler>(
	Object.entries({
	"authPublic.login": login,
	"authPublic.previewSignInStatus": constant({ enabled: false }),
	"auth.session": ({ dataset }) => Effect.succeed(session(dataset)),
	"auth.sessionRefresh": sessionRefresh,
	"aiModelsInternal.detectMany": detectAiModels,
	"integrations.cloudflareStatus": constant(disconnectedCloudflare),
	"integrations.railwayStatus": constant(disconnectedRailway),
	"planetscaleIntegration.status": constant(disconnectedPlanetScale),
	"gcpIntegration.status": constant({ object: "gcp_integration", metrics_available: false, connectors: [] }),
	"anomalies.serviceCounts": constant(emptyList),
	"investigations.list": constant(emptyList),
	"alertDeliveries.list": constant(emptyList),
	"sessionReplays.forTrace": constant(emptyList),
	"dashboards.listShares": constant([]),
	"billing.getCustomer": billingCustomer,
	"integrations.githubStatus": constant({
		connected: false,
		state: "not_connected",
		accountLogin: null,
		accountType: null,
		repositorySelection: null,
		ciTracesEnabled: true,
		repositories: [],
	}),
	"integrations.vcsCommitDetails": constant({ commits: [] }),
	"integrations.cloudflareHyperdrives": constant({ configs: [] }),
	"attributeMappings.list": constant(emptyList),
	"anomalies.listIncidents": constant(emptyList),
	// A seeded issue has no history beyond its warehouse occurrences.
	"errors.listIssueEvents": constant({ events: [] }),
	"errors.listIssuePullRequests": constant({ pullRequests: [], suggestedRepository: null }),
	"errors.listIssueVerifications": constant({ verifications: [] }),
	"errors.listIssueEscalations": constant({ attempts: [] }),
	"ingestKeys.retrieve": ingestKeys,
	"instrumentationRecommendations.list": constant(emptyList),
	"planetscaleIntegration.databases": constant({
		object: "planetscale_integration.database_list",
		databases: [],
		last_inventory_at: null,
	}),
	} satisfies Readonly<Record<string, EndpointHandler>>),
)
