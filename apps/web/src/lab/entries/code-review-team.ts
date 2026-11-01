import { OrgId } from "@maple/domain"
import { CodeReviewTeam } from "@maple/domain/http"
import { Clock, Effect, Result, Schema } from "effect"
import { Command } from "foldkit"
import type { PageContext } from "../../page/contract"
import * as Team from "../../page/code-review/team/model"
import { init, routeChanged, update } from "../../page/code-review/team/update"
import { view } from "../../page/code-review/team/view"
import { CodeReviewTeamSearch } from "../../route/search"
import { defineShellLab } from "../shell-lab"

// `/lab/code-review-team`: the Code Review Team tab over a month of a seven-person fixture team,
// inside the real shell. The reads answer from the fixture; sorting and Ranked follow the URL
// the page asks for.

const DAY = 86_400_000
const HOUR_MS = 3_600_000

const member = (
	login: string,
	counts: Readonly<{
		prs: number
		merged: number
		mergeHours: number | null
		findings: number
		critical: number
		resolved: number
		openAtMerge: number
		clean: number
		regressed: number
		ci: number
		firstTry: number
		green: number
		reruns: number
		cancelled: number
		runnerHours: number
	}>,
) => ({
	login,
	pullRequests: counts.prs,
	mergedPullRequests: counts.merged,
	medianMergeSeconds: counts.mergeHours === null ? null : counts.mergeHours * 3_600,
	findings: counts.findings,
	criticalFindings: counts.critical,
	resolvedFindings: counts.resolved,
	openAtMergeFindings: counts.openAtMerge,
	shippedClean: counts.clean,
	shippedRegressed: counts.regressed,
	ciRuns: counts.ci,
	firstTryRuns: counts.firstTry,
	firstTryGreen: counts.green,
	reruns: counts.reruns,
	cancelledRuns: counts.cancelled,
	runnerMs: counts.runnerHours * HOUR_MS,
})

// Logins no GitHub account holds, so the avatars fall back to initials.
const teamAt = (nowMs: number) =>
	Schema.decodeUnknownSync(CodeReviewTeam)({
		startTime: nowMs - 30 * DAY,
		endTime: nowMs,
		totals: {
			pullRequests: 101,
			mergedPullRequests: 88,
			medianMergeSeconds: 4.5 * 3_600,
			medianFirstReviewSeconds: 250,
			defaultBranchRuns: 640,
			defaultBranchFailed: 22,
			runnerMs: 396 * HOUR_MS,
			p95QueueMs: 48_000,
		},
		members: [
			member("acme-ada", {
				prs: 46,
				merged: 41,
				mergeHours: 3.1,
				findings: 88,
				critical: 6,
				resolved: 61,
				openAtMerge: 9,
				clean: 30,
				regressed: 1,
				ci: 1_240,
				firstTry: 860,
				green: 790,
				reruns: 14,
				cancelled: 330,
				runnerHours: 210,
			}),
			member("acme-jonas", {
				prs: 22,
				merged: 18,
				mergeHours: 7.8,
				findings: 40,
				critical: 5,
				resolved: 22,
				openAtMerge: 10,
				clean: 12,
				regressed: 2,
				ci: 520,
				firstTry: 380,
				green: 322,
				reruns: 9,
				cancelled: 120,
				runnerHours: 80,
			}),
			member("acme-leo", {
				prs: 0,
				merged: 0,
				mergeHours: null,
				findings: 0,
				critical: 0,
				resolved: 0,
				openAtMerge: 0,
				clean: 0,
				regressed: 0,
				ci: 120,
				firstTry: 90,
				green: 81,
				reruns: 2,
				cancelled: 20,
				runnerHours: 12,
			}),
			member("acme-mei", {
				prs: 6,
				merged: 6,
				mergeHours: 4.2,
				findings: 5,
				critical: 0,
				resolved: 4,
				openAtMerge: 0,
				clean: 5,
				regressed: 0,
				ci: 90,
				firstTry: 70,
				green: 66,
				reruns: 0,
				cancelled: 15,
				runnerHours: 9,
			}),
			member("acme-priya", {
				prs: 15,
				merged: 14,
				mergeHours: 1.6,
				findings: 18,
				critical: 1,
				resolved: 15,
				openAtMerge: 1,
				clean: 11,
				regressed: 0,
				ci: 300,
				firstTry: 220,
				green: 214,
				reruns: 1,
				cancelled: 70,
				runnerHours: 40,
			}),
			member("acme-sam", {
				prs: 3,
				merged: 2,
				mergeHours: 50,
				findings: 6,
				critical: 1,
				resolved: 2,
				openAtMerge: 2,
				clean: 1,
				regressed: 0,
				ci: 40,
				firstTry: 30,
				green: 24,
				reruns: 3,
				cancelled: 8,
				runnerHours: 4,
			}),
			member("acme-tomas", {
				prs: 9,
				merged: 7,
				mergeHours: 26,
				findings: 30,
				critical: 4,
				resolved: 9,
				openAtMerge: 8,
				clean: 4,
				regressed: 1,
				ci: 260,
				firstTry: 180,
				green: 141,
				reruns: 12,
				cancelled: 50,
				runnerHours: 35,
			}),
		],
	})

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_team"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const ServeFixtureTeam = Command.define("ServeFixtureCodeReviewTeam", {
	args: { key: Schema.String },
	messages: [Team.Message.CompletedFetchTeam],
	execute: ({ key }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Team.Message.CompletedFetchTeam({ key, result: Result.succeed(teamAt(nowMs)) }),
		),
})

const decodeSearch = Schema.decodeUnknownSync(CodeReviewTeamSearch)
type PageStep = ReturnType<typeof update>

/** The page's reads answered by the fixture; the GitHub status read is dropped (no repositories). */
const served = (result: PageStep) => ({
	model: result.model,
	commands: (result.commands ?? []).flatMap((command) => {
		if (command.name === "FetchCodeReviewTeam")
			return [ServeFixtureTeam({ key: result.model.team.key ?? "" })]
		return command.name === "FetchCodeReviewGithubStatus" ? [] : [command]
	}),
})

/** A navigation the page asks for becomes the lab's own route change. */
const followed = (result: PageStep) => {
	const out = result.outMessage
	if (out === undefined || out._tag !== "RequestedNavigation") return served(result)
	const search = decodeSearch(Object.fromEntries(new URL(out.url, "https://lab.local").searchParams))
	return served(routeChanged(result.model, { search }, context))
}

export const lab = defineShellLab("Code review team", {
	Model: Team.Model,
	Message: Team.Message,
	Flags: Schema.Struct({}),
	flags: Effect.succeed({}),
	init: () => served(init({ search: {} }, context)),
	update: (model, message) => followed(update(model, message, context)),
	view: (model, h) => view(model, { context }, h),
	currentPath: "/code-review/team",
	breadcrumbs: [{ label: "Code review", href: "/code-review" }, { label: "Team" }],
})
