import { Clock, Effect, Layer, Option, Redacted, Result, String as Str } from "effect"
import { Base64 } from "effect/encoding"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { DEFAULT_MAPLE_REGION } from "@maple/domain/organization-regions"
import { GoogleAdsConversionsPassword } from "@maple/infra/secrets"
import { secretsEqual } from "@maple/backend/services/auth/secret-equal"
import { AdConversionsService } from "@maple/backend/services/ad-conversions/AdConversionsService"
import { buildGoogleAdsConversionsCsv } from "@maple/backend/services/ad-conversions/google-ads-csv"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"

/**
 * `GET /internal/google-ads/conversions.csv`: ad sign-ups and activations as a Google Ads click
 * conversion import, fetched by a scheduled HTTPS upload with Basic auth. Only the default region
 * counts sign-ups, so only it serves the file.
 */
export const GOOGLE_ADS_CONVERSIONS_PATH = "/internal/google-ads/conversions.csv"
export const GOOGLE_ADS_USERNAME = "google-ads"

const plain = (body: string, status: number, headers: Record<string, string> = {}) =>
	HttpServerResponse.text(body, { status, headers: { "cache-control": "no-store", ...headers } })

/** Whether `Authorization: Basic ...` carries the expected username and password. */
export const isValidBasicAuth = (header: string | undefined, password: string): boolean => {
	if (header === undefined || !Str.startsWith("Basic ")(header)) return false
	const decoded = Base64.decodeString(Str.trim(Str.slice(6)(header)))
	if (Result.isFailure(decoded)) return false
	const separator = Str.indexOf(":")(decoded.success)
	if (Option.isNone(separator)) return false
	const userOk = secretsEqual(Str.slice(0, separator.value)(decoded.success), GOOGLE_ADS_USERNAME)
	const passwordOk = secretsEqual(Str.slice(separator.value + 1)(decoded.success), password)
	return userOk && passwordOk
}

/** The route with its services still open, so a test can drive it against stubs. */
export const GoogleAdsConversionsRoute = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const conversions = yield* AdConversionsService
		const regions = yield* OrganizationRegionService
		const bound = yield* GoogleAdsConversionsPassword
		const password = Option.map(bound, Redacted.value)
		yield* router.add(
			"GET",
			GOOGLE_ADS_CONVERSIONS_PATH,
			Effect.gen(function* () {
				if (regions.region !== DEFAULT_MAPLE_REGION) return plain("Not found", 404)
				if (Option.isNone(password)) return plain("Conversion export is not configured", 503)
				const request = yield* HttpServerRequest.HttpServerRequest
				if (!isValidBasicAuth(request.headers.authorization, password.value)) {
					return plain("Unauthorized", 401, { "www-authenticate": 'Basic realm="maple"' })
				}
				const now = yield* Clock.currentTimeMillis
				const rows = yield* conversions.listForExport(now)
				return HttpServerResponse.text(buildGoogleAdsConversionsCsv(rows), {
					status: 200,
					contentType: "text/csv; charset=utf-8",
					headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
				})
			}).pipe(
				Effect.tap((response) =>
					Effect.annotateCurrentSpan("http.response.status_code", response.status),
				),
				Effect.catchTag("@maple/backend/ad-conversions/AdConversionPersistenceError", (error) =>
					Effect.logError("Google Ads conversion export failed").pipe(
						Effect.annotateLogs({ error: error.message }),
						Effect.andThen(
							Effect.annotateCurrentSpan({
								"http.response.status_code": 503,
								"error.type": error._tag,
							}),
						),
						Effect.as(plain("Temporarily unavailable", 503, { "retry-after": "300" })),
					),
				),
			),
		)
	}),
)

export const GoogleAdsConversionsRouter = GoogleAdsConversionsRoute.pipe(
	Layer.provide(AdConversionsService.layer),
)
