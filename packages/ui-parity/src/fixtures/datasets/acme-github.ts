import { Effect, Predicate } from "effect"
import { VcsCommitNotFoundError } from "@maple/domain/http"
import type { EndpointHandler } from "../dataset.ts"
import { DAY, FROZEN_NOW_MS, MINUTE, fixtureUuid } from "../identity.ts"
import { ACME_RELEASES } from "../telemetry/acme-shop.ts"

/** Acme's GitHub App: one repository, whose commits are the dataset's release shas. */

const REPO = "acme-shop/shop"

const commitOf = (release: (typeof ACME_RELEASES)[number]) => {
	// Rollouts land at their deploy time; base versions shipped long before the window.
	const committedAt =
		FROZEN_NOW_MS -
		(release.minutesBeforeNow === undefined ? 9 * DAY : release.minutesBeforeNow * MINUTE + 20 * MINUTE)
	return {
		provider: "github",
		sha: release.sha,
		message: `release(${release.service}): ${release.version}`,
		authorName: "Acme Admin",
		authorEmail: "admin@acme.test",
		authorLogin: "acme-admin",
		authorAvatarUrl: null,
		authoredAt: committedAt,
		committedAt,
		htmlUrl: `https://github.com/${REPO}/commit/${release.sha}`,
		repoFullName: REPO,
		resolved: "stored",
	}
}

const field = (value: unknown, key: string): string =>
	Predicate.hasProperty(value, key) && typeof value[key] === "string" ? value[key] : ""

const status: EndpointHandler = () =>
	Effect.succeed({
		connected: true,
		state: "connected",
		accountLogin: "acme-shop",
		accountType: "organization",
		repositorySelection: "selected",
		ciTracesEnabled: true,
		repositories: [
			{
				id: fixtureUuid(5, 1),
				fullName: REPO,
				htmlUrl: `https://github.com/${REPO}`,
				isPrivate: true,
				status: "active",
				syncStatus: "ready",
				lastSyncedAt: FROZEN_NOW_MS - 5 * MINUTE,
				lastSyncError: null,
				trackedBranch: "main",
				branches: [{ name: "main", isDefault: true }],
				prReviewEnabled: false,
			},
		],
	})

/** Unknown shas are dropped from the bulk read and 404 on the single read, as the API does. */
export const acmeGithubEndpoints = {
	"integrations.githubStatus": status,
	"integrations.vcsCommitDetails": ({ query }) => {
		const shas = field(query, "shas").split(",")
		return Effect.succeed({
			commits: ACME_RELEASES.filter((release) => shas.includes(release.sha)).map(commitOf),
		})
	},
	"integrations.vcsPullRequests": ({ query }) =>
		Effect.succeed({ repository: field(query, "repository"), pullRequests: [] }),
	"integrations.vcsCommitDetail": ({ params }) => {
		const sha = field(params, "sha")
		const release = ACME_RELEASES.find((candidate) => candidate.sha === sha)
		return release === undefined
			? Effect.fail(new VcsCommitNotFoundError({ message: `Commit ${sha} not found`, sha }))
			: Effect.succeed(commitOf(release))
	},
} satisfies Readonly<Record<string, EndpointHandler>>
