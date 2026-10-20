import { GithubRepoSummary, VcsRepositoryId } from "@maple/domain/http"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import {
	initRepoList,
	pinOnce,
	RepoFilter,
	RepoListState,
	repositoryList,
} from "../../page/code-review/settings/repositories"
import { defineLab } from "../define"

// `/lab/code-review-repos`: the repository picker
// over 246 fixture repositories.
// TODO(lab-toggle): the switch flips locally; the fixture repositories exist nowhere to write to
// (`githubSetPrReview`).

// The fixture repositories.
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
	const base = NAMES[i % NAMES.length] ?? "repo"
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

const Model = Schema.Struct({ list: RepoListState, toggled: Schema.Array(Schema.String) })
type Model = typeof Model.Type

const Message = defineMessageUnion({
	ChangedSearch: { value: Schema.String },
	PickedFilter: { filter: RepoFilter },
	ClickedShowAll: {},
	ToggledRepo: { id: Schema.String },
	ClickedConfigure: {},
})
type Message = typeof Message.Type

const isEnabled = (model: Model, repo: GithubRepoSummary) =>
	repo.prReviewEnabled !== model.toggled.includes(repo.id)

const update = (model: Model, message: Message): Model =>
	Message.match<Model>(message, {
		ChangedSearch: ({ value }) => ({ ...model, list: { ...model.list, search: value } }),
		PickedFilter: ({ filter }) => ({ ...model, list: { ...model.list, filter } }),
		ClickedShowAll: () => ({ ...model, list: { ...model.list, search: "", filter: "all" } }),
		ToggledRepo: ({ id }) => ({
			...model,
			toggled: model.toggled.includes(id)
				? model.toggled.filter((other) => other !== id)
				: [...model.toggled, id],
		}),
		ClickedConfigure: () => model,
	})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto max-w-4xl p-8")],
		[
			repositoryList(h, {
				repositories: REPOS,
				state: model.list,
				isAdmin: true,
				busy: [],
				isEnabled: (repo) => isEnabled(model, repo),
				onSearch: (value) => Message.ChangedSearch({ value }),
				onFilter: (filter) => Message.PickedFilter({ filter }),
				onShowAll: Message.ClickedShowAll(),
				onToggle: (repo) => Message.ToggledRepo({ id: repo.id }),
				onConfigure: () => Message.ClickedConfigure(),
			}),
		],
	)

export const lab = defineLab("Code review repositories", {
	Model,
	init: () => ({ model: { list: pinOnce(initRepoList(), REPOS), toggled: [] } }),
	update: (model, message) => ({ model: update(model, message) }),
	view,
})
