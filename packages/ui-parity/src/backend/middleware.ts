import { Context, Effect, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiError } from "effect/http-api"
import {
	ApiRequestValidationError,
	ApiSchemaErrors,
	ApiUnexpectedError,
	ApiUnexpectedErrors,
	CurrentTenant,
	UnauthorizedError,
} from "@maple/domain/http"
import {
	AuthorizationV2,
	V2InvalidCredentials,
	V2InvalidRequest,
	V2ResponseSchemaFailure,
	V2SchemaErrors,
	V2UnexpectedErrors,
	V2UnexpectedFailure,
} from "@maple/domain/http/v2"
import { OrgId, RoleName, UserId } from "@maple/domain/primitives"
import type { Dataset } from "../fixtures/dataset.ts"
import { acceptsBearer } from "./auth.ts"

/** Resolves the dataset a request belongs to (from the `x-parity-dataset` header). */
export type DatasetOf = (request: HttpServerRequest.HttpServerRequest) => Dataset

/** Reports a response that failed its own schema: the fixture is wrong, so the variant must fail. */
export type ReportInvalidFixture = (request: HttpServerRequest.HttpServerRequest, description: string) => void

const tenantFor = (dataset: Dataset): CurrentTenant.TenantSchema | undefined => {
	const identity = dataset.identity
	if (identity === null) return undefined
	const roles =
		dataset.auth === "self_hosted" ? ["root"] : identity.role === "admin" ? ["org:admin"] : ["org:member"]
	return new CurrentTenant.TenantSchema({
		orgId: OrgId.make(identity.orgId),
		userId: UserId.make(identity.userId),
		roles: roles.map((role) => RoleName.make(role)),
		authMode: dataset.auth,
	})
}

/** The tenant the bearer proves, or `undefined` for a 401 (signed out, or no fixture token). */
const authenticate = (datasetOf: DatasetOf, credential: Redacted.Redacted<string>) =>
	Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
		const dataset = datasetOf(request)
		return acceptsBearer(dataset, Redacted.value(credential)) ? tenantFor(dataset) : undefined
	})

const unauthorized = () => new UnauthorizedError({ message: "Invalid or missing credentials." })

const schemaErrorMessage = (kind: string, message: string) => `Invalid request ${kind.toLowerCase()}: ${message}`

const UNEXPECTED_MESSAGE = "An unexpected error occurred on our end."

/** Runs `effect` as the dataset's tenant, or fails with `onMissing()` like the API's 401. */
const withTenant = <A, E, R, E2>(
	datasetOf: DatasetOf,
	effect: Effect.Effect<A, E, R>,
	credential: Redacted.Redacted<string>,
	onMissing: () => E2,
): Effect.Effect<A, E | E2, Exclude<R, CurrentTenant.Context> | HttpServerRequest.HttpServerRequest> =>
	Effect.gen(function* () {
		const tenant = yield* authenticate(datasetOf, credential)
		if (tenant === undefined) return yield* Effect.fail(onMissing())
		return yield* Effect.provideService(effect, CurrentTenant.Context, tenant)
	})

/** Request-decode failures become `onRequest(...)`; response-encode failures report the fixture. */
const schemaBoundary = <A, E, R, E1, E2>(
	effect: Effect.Effect<A, E, R>,
	report: (message: string) => Effect.Effect<void, never, HttpServerRequest.HttpServerRequest>,
	onRequest: (kind: string, message: string) => E1,
	onResponse: () => E2,
): Effect.Effect<A, E | E1 | E2, R | HttpServerRequest.HttpServerRequest> =>
	Effect.catch(effect, (error) =>
		Effect.gen(function* () {
			if (!HttpApiError.HttpApiSchemaError.is(error)) return yield* Effect.fail(error)
			if (error.kind === "Body" || error.kind === "ResponseHeaders") {
				yield* report(error.cause.message)
				return yield* Effect.fail(onResponse())
			}
			return yield* Effect.fail(onRequest(error.kind, error.cause.message))
		}),
	)

/**
 * Every middleware the four HttpApis declare. Bearer middlewares answer from the dataset;
 * schema middlewares turn bad requests into the API's 400 envelopes, and a response that fails
 * its schema into a 500 plus an `invalid-fixture` report.
 */
export const middlewareContext = (datasetOf: DatasetOf, reportInvalid: ReportInvalidFixture) => {
	const report = (group: string, endpoint: string) => (message: string) =>
		Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
			Effect.sync(() => reportInvalid(request, `invalid-fixture:${group}.${endpoint}: ${message}`)),
		)
	const sessionBearer = {
		bearer: <A, E, R>(effect: Effect.Effect<A, E, R>, { credential }: { readonly credential: Redacted.Redacted<string> }) =>
			withTenant(datasetOf, effect, credential, unauthorized),
	}
	return Context.make(CurrentTenant.Authorization, CurrentTenant.Authorization.of(sessionBearer)).pipe(
		Context.add(CurrentTenant.SessionAuthorization, CurrentTenant.SessionAuthorization.of(sessionBearer)),
		Context.add(
			CurrentTenant.RegionlessSessionAuthorization,
			CurrentTenant.RegionlessSessionAuthorization.of(sessionBearer),
		),
		Context.add(
			CurrentTenant.UserSessionAuthorization,
			CurrentTenant.UserSessionAuthorization.of({
				bearer: (effect, { credential }) =>
					Effect.gen(function* () {
						const tenant = yield* authenticate(datasetOf, credential)
						if (tenant === undefined) return yield* Effect.fail(unauthorized())
						return yield* Effect.provideService(effect, CurrentTenant.CurrentUser, { userId: tenant.userId })
					}),
			}),
		),
		Context.add(
			AuthorizationV2,
			AuthorizationV2.of({
				bearer: (effect, { credential }) =>
					withTenant(datasetOf, effect, credential, () => V2InvalidCredentials.make()),
			}),
		),
		Context.add(
			ApiSchemaErrors,
			ApiSchemaErrors.of((effect, { endpoint, group }) =>
				schemaBoundary(
					effect,
					report(group.identifier, endpoint.identifier),
					(kind, message) =>
						new ApiRequestValidationError({ message: schemaErrorMessage(kind, message), details: [message] }),
					() => new ApiUnexpectedError({ message: UNEXPECTED_MESSAGE }),
				),
			),
		),
		Context.add(
			ApiUnexpectedErrors,
			ApiUnexpectedErrors.of((effect) =>
				Effect.catchDefect(effect, () => Effect.fail(new ApiUnexpectedError({ message: UNEXPECTED_MESSAGE }))),
			),
		),
		Context.add(
			V2SchemaErrors,
			V2SchemaErrors.of((effect, { endpoint, group }) =>
				schemaBoundary(
					effect,
					report(group.identifier, endpoint.identifier),
					(kind, message) => V2InvalidRequest.make(schemaErrorMessage(kind, message)),
					() => V2ResponseSchemaFailure.make(),
				),
			),
		),
		Context.add(
			V2UnexpectedErrors,
			V2UnexpectedErrors.of((effect) => Effect.catchDefect(effect, () => Effect.fail(V2UnexpectedFailure.make()))),
		),
	)
}
