import type { GithubIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import { githubFlow } from "./flow-github"
import { GITHUB_STATUS_READ, type GithubCardModel, GithubMessage, initGithubCard } from "./github"
import {
	attentionOr,
	type CardStatus,
	CONNECT,
	fold,
	type IntegrationOverview,
	lastSyncOf,
	maxMs,
	NOT_CONNECTED,
	unavailableOverview,
	unavailableStatus,
} from "./overview"
import type { ProviderModule } from "./provider"
import { isPolling, openedPopup, receivedSelection, statusAnswered, update } from "./update-github"
import { githubFlowView } from "./view-flow-github"
import { githubCard } from "./view-github"

// GitHub's part of `/integrations` and `/sources/new`: the app install and its account picker,
// the feature switches, and the repositories with their tracked branches.

/** A branch change that queued a backfill re-reads every 3 s for this long. */
const FORCE_POLL_WINDOW_MS = 10_000

export const GITHUB: ProviderModule<GithubIntegrationStatus, GithubCardModel, GithubMessage> = {
	id: "github",
	statusRead: GITHUB_STATUS_READ,
	init: initGithubCard,
	update,
	onStatus: statusAnswered,
	blocksConnect: (model) => model.selectingInstallation !== null,
	onConnectOpened: openedPopup,
	onConnectPayload: receivedSelection,
	subscription: {
		everyMs: 3_000,
		isActive: isPolling,
		tick: GithubMessage.TickedGithubPoll(),
	},
	// The window ends on its own, with one last read once the tab is back.
	delayed: {
		afterMs: FORCE_POLL_WINDOW_MS,
		versionOf: (model) => (model.isForcePolling ? model.forcePollVersion : null),
		fire: (version) => [
			GithubMessage.TickedGithubPoll(),
			GithubMessage.EndedGithubForcePoll({ version }),
		],
	},
	card: (h, model, timeZone) => githubCard(h, model, timeZone),
	flow: githubFlow,
	flowView: (h, model, stage) => githubFlowView(h, model, stage),
	cardStatus: (slot) =>
		fold(
			slot,
			(status): CardStatus => {
				if (status.state === "disconnected") return { label: "Deactivated", variant: "warn" }
				if (status.state === "suspended") return { label: "Suspended", variant: "warn" }
				if (!status.connected) return NOT_CONNECTED
				const count = Arr.filter(status.repositories, (repo) => repo.status === "active").length
				return { label: count > 0 ? countLabel(count, "repo") : "Connected", variant: "ok" }
			},
			unavailableStatus,
		),
	overview: (slot) =>
		fold(
			slot,
			(status): IntegrationOverview => {
				const context =
					status.accountLogin !== null ? `@${status.accountLogin} · GitHub App` : "GitHub App"
				const halted = (stateLabel: string, issue: string): IntegrationOverview => ({
					kind: "connected",
					health: "attention",
					stateLabel,
					context,
					stat: null,
					lastSync: null,
					issue,
				})
				if (status.state === "disconnected") return halted("Deactivated", "Reinstall the app")
				if (status.state === "suspended") return halted("Suspended", "Suspended on GitHub")
				if (!status.connected) return CONNECT
				const active = Arr.filter(status.repositories, (repo) => repo.status === "active")
				const removed = status.repositories.length - active.length
				const failing = Arr.filter(active, (repo) => repo.lastSyncError != null).length
				const issue =
					failing > 0
						? `${countLabel(failing, "repo")} failing`
						: removed > 0
							? `${countLabel(removed, "repo")} removed`
							: null
				return {
					kind: "connected",
					...attentionOr(issue),
					context,
					stat: active.length > 0 ? `${countLabel(active.length, "repo")} synced` : null,
					lastSync: lastSyncOf(maxMs(Arr.map(active, (repo) => repo.lastSyncedAt))),
					issue,
				}
			},
			unavailableOverview,
		),
}
