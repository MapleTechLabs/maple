import { Schema } from "effect"
import { CiRunResult } from "@maple/domain/http"
import type { Tone } from "@maple/ui/lib/tone"

export const CI_RESULT_LABELS = {
	success: "Succeeded",
	failure: "Failed",
	timeout: "Timed out",
	cancellation: "Cancelled",
	skip: "Skipped",
	error: "Errored",
} satisfies Record<CiRunResult, string>

const CI_RESULT_TONES = {
	success: "ok",
	failure: "crit",
	timeout: "crit",
	error: "crit",
	cancellation: "neutral",
	skip: "neutral",
} satisfies Record<CiRunResult, Tone>

export const isCiRunResult = Schema.is(CiRunResult)

/** Runs carry the result as a plain string; an unknown one shows as is, muted. */
export const ciResultLabel = (result: string): string =>
	isCiRunResult(result) ? CI_RESULT_LABELS[result] : result

export const ciResultTone = (result: string): Tone =>
	isCiRunResult(result) ? CI_RESULT_TONES[result] : "neutral"

/** Passed runs over decided ones: a cancelled run says nothing about the code. */
export function successRate(totals: { readonly succeeded: number; readonly failed: number }): number | null {
	const decided = totals.succeeded + totals.failed
	return decided === 0 ? null : totals.succeeded / decided
}

export const failRate = (failed: number, runs: number): number | null => (runs === 0 ? null : failed / runs)

/** Change between two rates in points (0.05 = +5pp); null without both. */
export const rateChange = (current: number | null, previous: number | null): number | null =>
	current === null || previous === null ? null : current - previous

const RUN_URL = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/actions\/runs\//u

/** The pull request's page, from the run's `<repo>/actions/runs/<id>` URL. */
export function pullRequestUrl(runUrl: string, pullRequest: number): string | null {
	const repository = RUN_URL.exec(runUrl)?.[1]
	return repository === undefined ? null : `${repository}/pull/${pullRequest}`
}

/**
 * A span-supplied link, only when it is http(s): anything that can write CI spans for the org sets
 * these, and a `javascript:` href would run in Maple's origin.
 */
export function externalUrl(value: string): string | null {
	return URL.canParse(value) && /^https?:$/u.test(new URL(value).protocol) ? value : null
}
