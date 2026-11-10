import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
export { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { Effect, Layer } from "effect"
import { AnomalyDetectionService } from "@maple/backend/services/alerts/AnomalyDetectionService"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { ErrorIssueMergeService } from "@maple/backend/services/errors/ErrorIssueMergeService"
import { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { ApiV2RateLimiter } from "@maple/backend/services/auth/ApiV2RateLimiter"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"

// Test-only stubs for the v2 HTTP harnesses. Each harness builds an API of only
// the groups it exercises and provides those groups' services itself.

/**
 * An empty workspace directory: the audit log falls back to rendering ids,
 * which is the same shape a self-hosted deployment without Clerk sees.
 */
export const OrgMembersServiceStubLayer = Layer.succeed(OrgMembersService, {
	listMembers: () => Effect.succeed([]),
	listOrganizationsOf: () => Effect.succeed([]),
	listMemberActivity: () => Effect.succeed([]),
	resolveMembers: () => Effect.succeed([]),
})

const die = () => Effect.die(new Error("This service is not available in this test harness"))

export const ApiV2RateLimiterAllowAllLayer = Layer.succeed(ApiV2RateLimiter, {
	check: () => Effect.succeed("allowed" as const),
})

/** Synchronous stub for non-Effect-returning service methods (e.g. `asExecutor`). */
const dieSync = (): never => {
	throw new Error("This service method is not available in this test harness")
}

/** Inert stubs for the services behind the investigations, anomalies, error issues and organization groups. */
export const Phase1ResourceStubsLayer = Layer.mergeAll(
	Layer.succeed(InvestigationService, {
		listInvestigations: die,
		getInvestigation: die,
		createInvestigation: die,
		createAndStartInvestigation: die,
		restartInvestigation: die,
		updateStatus: die,
		submitDiagnosis: die,
		recordProgress: die,
		failInvestigation: die,
	}),
	Layer.succeed(AnomalyDetectionService, {
		runTick: die(),
		listIncidents: die,
		countIncidentsByService: die,
		getIncident: die,
		resolveIncidentManually: die,
		setIncidentIssue: die,
		getIncidentTimeseries: die,
		getSettings: die,
		updateSettings: die,
	}),
	Layer.succeed(ErrorIssueReadModelsService, {
		listIssues: die,
		countOpenIssuesByService: die,
		countIssues: die,
		getIssue: die,
		listIssueAffectedUsers: die,
		listIssueIncidents: die,
		listOpenIncidents: die,
		listIncidentsOfIssues: die,
	}),
	Layer.succeed(ErrorsService, {
		transitionIssue: die,
		claimIssue: die,
		proposeFix: die,
		recordAnomalyLinkEvent: die,
		runTick: die(),
	}),
	Layer.succeed(ErrorIssueWorkflowService, {
		rowToIssue: dieSync,
		requireIssue: die,
		issuesWithOpenIncidents: die,
		hydrateIssueRows: die,
		hydrateIssue: die,
		recordEvent: die,
		buildEvent: dieSync,
		recordEventAudit: die,
		fingerprintHashesOf: die,
		applyTransition: die,
		heartbeatIssue: die,
		releaseIssue: die,
		assignIssue: die,
		setSeverity: die,
		commentOnIssue: die,
		listIssueEvents: die,
	}),
	Layer.succeed(ErrorIssueMergeService, {
		mergeIssues: die,
		unmergeIssue: die,
	}),
	Layer.succeed(ErrorActorsService, {
		registerAgent: die,
		listAgents: die,
		lookupActor: die,
		ensureUserActor: die,
		actorExists: die,
		ensureSystemActor: die,
		ensureAgentActor: die,
		touchActor: die,
		collectActorDocs: die,
		findOwnedAgentActor: die,
	}),
	Layer.succeed(OrganizationService, {
		create: die,
		chooseRegion: die,
		retrieve: die,
		delete: die,
	}),
)

export const WarehouseServiceStubLayer = Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub())

export const TelemetryServiceStubsLayer = Layer.mergeAll(
	Layer.succeed(QueryEngineService, {
		execute: die,
		evaluate: die,
		evaluateSeries: die,
		cachedDirect: die,
	}),
)
