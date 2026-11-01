import { DependencyFindingId, DependencyFindingTriageStatus } from "@maple/domain/dependency-scan"
import { VcsRepositoryId } from "@maple/domain/http"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { readIsAdmin } from "../../alerts/shared/commands"
import { Message } from "./model"

// The Dependencies tab's reads and writes on the api Worker. Names start with `SecurityApi` (and
// the clock's and session's with `ReadSecurity`) so the lab drops them.

type Api = typeof MapleInternalApiClient.Service

const call = <A, E, R>(run: (api: Api) => Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const api = yield* MapleInternalApiClient
		return yield* run(api)
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const ReadDependenciesClock = Command.define("ReadSecurityDependenciesClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const ReadDependenciesIsAdmin = Command.define("ReadSecurityDependenciesIsAdmin", {
	messages: [Message.CompletedReadIsAdmin],
	execute: Effect.map(readIsAdmin, (isAdmin) => Message.CompletedReadIsAdmin({ isAdmin })),
})

export const FetchRepositories = Command.define("SecurityApiDependencyRepositories", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchRepositories],
	execute: ({ key }) =>
		Effect.map(
			call((api) => api.dependencyScan.listRepositories()),
			(result) => Message.CompletedFetchRepositories({ key, result }),
		),
})

export const FetchFindings = Command.define("SecurityApiDependencyFindings", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchFindings],
	execute: ({ key }) =>
		Effect.map(
			call((api) => api.dependencyScan.listFindings({ query: {} })),
			(result) => Message.CompletedFetchFindings({ key, result }),
		),
})

export const ScanRepository = Command.define("SecurityApiScanRepository", {
	args: { repositoryId: VcsRepositoryId },
	messages: [Message.CompletedScanRequest],
	execute: ({ repositoryId }) =>
		Effect.map(
			call((api) => api.dependencyScan.scanRepository({ params: { repositoryId } })),
			(result) => Message.CompletedScanRequest({ repositoryId, result }),
		),
})

export const UpdateFinding = Command.define("SecurityApiUpdateDependencyFinding", {
	args: { findingId: DependencyFindingId, status: DependencyFindingTriageStatus, reason: Schema.String },
	messages: [Message.CompletedTriage],
	execute: ({ findingId, status, reason }) =>
		Effect.map(
			call((api) =>
				api.dependencyScan.updateFinding({
					params: { findingId },
					payload: reason === "" ? { status } : { status, reason },
				}),
			),
			(result) => Message.CompletedTriage({ result }),
		),
})
