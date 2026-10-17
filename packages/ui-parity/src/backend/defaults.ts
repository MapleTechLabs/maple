import { Effect } from "effect"
import { SelfHostedAuthDisabledError, SelfHostedInvalidPasswordError, UnauthorizedError } from "@maple/domain/http"
import type { Dataset, EndpointHandler } from "../fixtures/dataset.ts"
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
	"integrations.cloudflareStatus": constant(disconnectedCloudflare),
	"integrations.railwayStatus": constant(disconnectedRailway),
	"planetscaleIntegration.status": constant(disconnectedPlanetScale),
	"gcpIntegration.status": constant({ object: "gcp_integration", metrics_available: false, connectors: [] }),
	"queryEngine.infraPresence": constant({ surfaces: [] }),
	"anomalies.serviceCounts": constant(emptyList),
	"errorIssues.list": constant(emptyList),
	"errorIssues.serviceCounts": constant(emptyList),
	"investigations.list": constant(emptyList),
	"alertDeliveries.list": constant(emptyList),
	"sessionReplays.forTrace": constant(emptyList),
	"dashboards.listShares": constant([]),
	} satisfies Readonly<Record<string, EndpointHandler>>),
)
