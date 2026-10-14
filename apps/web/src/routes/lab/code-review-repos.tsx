import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"
import { GithubRepoSummary, VcsRepositoryId } from "@maple/domain/http"

import { RepositoryList } from "@/components/code-review/code-review-settings"

const NAMES = [
	"web",
	"api",
	"mobile-ios",
	"mobile-android",
	"worker-proxy",
	"worker-proxy-go",
	"k8s-manifests",
	"ios-quickstart",
	"objc-quickstart",
	"checkout",
	"dashboard",
	"sdk-js",
	"sdk-python",
	"sdk-go",
	"docs",
	"infra",
	"terraform-modules",
	"billing-service",
	"analytics-pipeline",
	"marketing-site",
]
const decodeId = Schema.decodeSync(VcsRepositoryId)
const REPOS = Array.from({ length: 246 }, (_, i) => {
	const base = NAMES[i % NAMES.length]
	const name = i < NAMES.length ? base : `${base}-${Math.floor(i / NAMES.length)}`
	return new GithubRepoSummary({
		id: decodeId(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
		fullName: `acme/${name}`,
		htmlUrl: `https://github.com/acme/${name}`,
		isPrivate: i % 7 !== 0,
		status: "active",
		syncStatus: "ready",
		lastSyncedAt: null,
		lastSyncError: null,
		trackedBranch: null,
		branches: [],
		prReviewEnabled: i === 8 || i === 9,
	})
})

function CodeReviewReposLab() {
	return (
		<div className="mx-auto max-w-4xl p-8">
			<RepositoryList repositories={REPOS} inherited={undefined} />
		</div>
	)
}

export const Route = createFileRoute("/lab/code-review-repos")({ component: CodeReviewReposLab })
