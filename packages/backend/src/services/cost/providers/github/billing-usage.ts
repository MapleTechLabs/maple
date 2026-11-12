// One month of an organization's GitHub billing usage report, read through its App installation,
// with every way GitHub refuses it as what the sync does next and what the Cost page shows.
import type { VcsInstallationGoneError, VcsProviderError, VcsRateLimitedError } from "@maple/domain/http"
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import type { VcsBillingMonth, VcsProviderClient } from "../../../integrations/vcs/VcsProviderClient"
import { CostProviderError, type CostPullWindow } from "../../CostProvider"
import { monthStart } from "../../sync-plan"
import { type UsageItem, UsageReport } from "./normalize"

type Reason = CostProviderError["reason"]

// GitHub does not bill for API requests, so no failure counts any.
export const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "github", reason, requests: 0 })

/** The organization has not accepted the permission the billing report needs. */
export const BILLING_NOT_GRANTED =
	"GitHub has not granted Maple access to billing yet. Accept the new permission in the organization's GitHub App settings."

const NOT_ON_BILLING_PLATFORM =
	"GitHub has no usage report for this organization: it is not on GitHub's enhanced billing platform."

const NOT_ACTING = "GitHub no longer lets Maple act for this organization. Reconnect GitHub."

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(UsageReport))

/** The month a `YYYY-MM-DD` day is in. */
export const monthOf = (day: string): VcsBillingMonth => ({
	year: Number(Str.slice(0, 4)(day)),
	month: Number(Str.slice(5, 7)(day)),
})

/** The calendar months a window touches, oldest first: the report is asked for one month at a time. */
export const monthsOfWindow = (window: CostPullWindow): ReadonlyArray<VcsBillingMonth> => {
	const last = monthStart(window.endDay)
	return Arr.unfold(
		monthStart(window.startDay),
		(start): Option.Option<readonly [VcsBillingMonth, string]> =>
			start > last ? Option.none() : Option.some([monthOf(start), monthStart(start, 1)]),
	)
}

const refused = (status: number, body: string): CostProviderError => {
	if (status === 401) {
		return failed("auth", "GitHub rejected Maple's access to this organization. Reconnect GitHub.")
	}
	if (status === 403 || status === 404) return failed("not_ready", BILLING_NOT_GRANTED)
	if (status === 429) return failed("rate_limited", "GitHub is rate limiting billing requests.")
	// An organization on the older billing has no report: GitHub says so in the body.
	return /billing platform/i.test(body)
		? failed("not_ready", NOT_ON_BILLING_PLATFORM)
		: failed("upstream", `GitHub answered ${status} to the billing request.`)
}

const fromProviderError = (
	error: VcsProviderError | VcsInstallationGoneError | VcsRateLimitedError,
): CostProviderError => {
	switch (error._tag) {
		case "@maple/http/errors/VcsRateLimitedError":
			return failed("rate_limited", "GitHub is rate limiting billing requests.")
		case "@maple/http/errors/VcsInstallationGoneError":
			return failed("auth", NOT_ACTING)
		// A refused report is an answer, so a 401 or 403 here is the token mint: the installation's gate.
		case "@maple/http/errors/VcsProviderError":
			return error.status === 401 || error.status === 403
				? failed("auth", NOT_ACTING)
				: failed("upstream", "GitHub did not answer the billing request.")
	}
}

/** Every usage line of `month` for the installation's organization. */
export const readUsageMonth = (
	github: VcsProviderClient,
	installation: { readonly externalInstallationId: string; readonly accountLogin: string },
	month: VcsBillingMonth,
): Effect.Effect<ReadonlyArray<UsageItem>, CostProviderError> =>
	github.fetchBillingUsage(installation, month).pipe(
		Effect.mapError(fromProviderError),
		Effect.flatMap((answer) => {
			switch (answer._tag) {
				case "NotGranted":
					return Effect.fail(failed("not_ready", BILLING_NOT_GRANTED))
				case "Refused":
					return Effect.fail(refused(answer.status, answer.body))
				case "Usage":
					return decodeReport(answer.body).pipe(
						Effect.mapBoth({
							onSuccess: (report) => report.usageItems ?? [],
							onFailure: () =>
								failed("invalid_response", "GitHub's billing answer could not be read."),
						}),
					)
			}
		}),
	)
