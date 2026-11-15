import { Effect, Schema, Array as Arr } from "effect"
import {
	CommitSha,
	DeploymentEnvironment,
	ServiceDeploysRequest,
	ServiceName,
	type DeployVerificationRow,
} from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { toEnvFilter } from "./custom-charts"
import { toIsoBucket } from "./timeseries-utils"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

const GetServiceDeploysInput = Schema.Struct({
	serviceName: Schema.optional(ServiceName),
	commitSha: Schema.optional(CommitSha),
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	environments: Schema.optional(Schema.Array(DeploymentEnvironment)),
})

export type GetServiceDeploysInput = (typeof GetServiceDeploysInput)["Encoded"]

interface ServiceDeploysResult {
	/** Versions first seen inside the window, newest first, `firstSeen` in ISO. */
	deploys: DeployVerificationRow[]
	/** Width of each side of a verification, seconds. */
	verifyWindowSeconds: number
}

/** A service's deploys in the window (or one commit's, across services), each with its before and after. */
export const getServiceDeploys = Effect.fn("QueryEngine.getServiceDeploys")(function* ({
	data,
}: {
	data: GetServiceDeploysInput
}) {
	const input = yield* decodeInput(GetServiceDeploysInput, data, "getServiceDeploys")
	const result = yield* runWarehouseQuery("serviceDeploys", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.serviceDeploys({
				payload: new ServiceDeploysRequest({
					serviceName: input.serviceName,
					commitSha: input.commitSha,
					startTime: input.startTime,
					endTime: input.endTime,
					environments: toEnvFilter(input.environments),
				}),
			})
		}),
	)
	return {
		deploys: Arr.map(result.deploys, (row) => ({ ...row, firstSeen: toIsoBucket(row.firstSeen) })),
		verifyWindowSeconds: result.verifyWindowSeconds,
	} satisfies ServiceDeploysResult
})
