import type { GithubIntegrationStatus, GithubRepoSummary } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import type { FlowSpec, LiveHealth } from "./flow"
import type { Model } from "./model"
import { githubStatusOf } from "./update-github"

// GitHub's place in the connect flow: install the app, then Go live. Repositories are picked on
// GitHub during install, so there is no Choose data step.

export const activeRepos = (status: GithubIntegrationStatus): ReadonlyArray<GithubRepoSummary> =>
	status.repositories.filter((repo) => repo.status === "active")

/** Where the app is installed: "Installed on acme". */
export const githubReach = (status: GithubIntegrationStatus): string =>
	status.accountLogin !== null && status.accountLogin !== ""
		? `Installed on ${status.accountLogin}`
		: "GitHub App installed"

const liveOf = (status: GithubIntegrationStatus | null): LiveHealth => {
	if (status === null) return "pending"
	if (status.repositoryDiscovery?._tag === "Pending") return "pending"
	if (status.repositoryDiscovery?._tag === "Failed") return "attention"
	if (status.state === "suspended" || status.state === "disconnected") return "attention"
	if (!status.connected) return "pending"
	const repos = activeRepos(status)
	return repos.length === 0 || repos.some((repo) => repo.syncStatus === "error")
		? "attention"
		: repos.every((repo) => repo.syncStatus === "ready")
			? "healthy"
			: "pending"
}

export const githubFlow = (model: Model): FlowSpec => {
	const status = githubStatusOf(model)
	const connected =
		model.githubCard.selection === null && status !== null && status.connected
			? githubReach(status)
			: null
	const repos = status === null ? 0 : activeRepos(status).length
	const live = liveOf(status)
	return {
		stages: ["connect", "live"],
		connected,
		chosen: null,
		live,
		hint: {
			connect:
				model.githubCard.selection !== null
					? "Choose an account to finish connecting."
					: status?.repositoryDiscovery?._tag === "Pending"
						? "Discovering repositories."
						: status?.repositoryDiscovery?._tag === "Failed"
							? status.repositoryDiscovery.message
							: connected !== null
								? `${countLabel(repos, "repository", "repositories")} granted`
								: model.connect.active !== null
									? "Waiting for GitHub to send you back."
									: "Connect GitHub to continue.",
			choose: "",
			live:
				status?.repositoryDiscovery?._tag === "Pending"
					? "Discovering repositories. Checks keep running if you leave."
					: status?.repositoryDiscovery?._tag === "Failed"
						? status.repositoryDiscovery.message
						: live === "healthy"
							? "GitHub is live."
							: status !== null && !status.connected
								? "Access lost. Reconnect GitHub to resume."
								: "Saved. Checks keep running if you leave.",
		},
	}
}
