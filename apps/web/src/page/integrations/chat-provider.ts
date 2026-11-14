import type { V2ChatConnectorList } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { Option, Array as Arr } from "effect"
import { chatConnectorOf, chatIntegrationId } from "./catalog"
import { CHAT_STATUS_READ, type ChatCardModel, type ChatMessage, initChatCard } from "./chat"
import {
	type CardStatus,
	CONNECT,
	fold,
	type IntegrationOverview,
	NOT_CONFIGURED,
	NOT_CONNECTED,
	unavailableOverview,
	unavailableStatus,
} from "./overview"
import type { ProviderModule } from "./provider"
import { confirmedDisconnect, isDisconnecting, update } from "./update-chat"
import { chatCard } from "./view-chat-card"

// The chat connectors' part of `/integrations` (Slack and the rest): one module for every
// `chat-<connector>` page, over the one connector list.

const workspacesOf = (response: V2ChatConnectorList, id: string) =>
	Arr.findFirst(response.data, (entry) => chatIntegrationId(entry.id) === id)

export const CHAT: ProviderModule<V2ChatConnectorList, ChatCardModel, ChatMessage> = {
	id: "chat",
	owns: (id) => chatConnectorOf(id) !== null,
	statusRead: CHAT_STATUS_READ,
	init: initChatCard,
	update,
	onConfirmDisconnect: (model) => confirmedDisconnect(model),
	isDisconnecting,
	card: (h, model, timeZone) => [chatCard(h, model, timeZone)],
	cardStatus: (slot, { id }) =>
		fold(
			slot,
			(response): CardStatus => {
				const connector = workspacesOf(response, id)
				const workspaces = Option.match(connector, {
					onNone: () => [],
					onSome: (found) => found.workspaces,
				})
				if (workspaces.length === 0)
					return Option.exists(connector, (found) => found.available === false)
						? NOT_CONFIGURED
						: NOT_CONNECTED
				return {
					label:
						workspaces.length === 1
							? (workspaces[0]?.name ?? "Connected")
							: `${workspaces.length} workspaces`,
					variant: "ok",
				}
			},
			unavailableStatus,
		),
	overview: (slot, { id }) =>
		fold(
			slot,
			(response): IntegrationOverview => {
				const workspaces = workspacesOf(response, id).pipe(
					Option.flatMapNullishOr((found) => found.workspaces),
					Option.getOrElse(() => []),
				)
				if (workspaces.length === 0) return CONNECT
				return {
					kind: "connected",
					health: "healthy",
					stateLabel: "Healthy",
					context:
						workspaces.length === 1
							? (workspaces[0]?.name ?? null)
							: countLabel(workspaces.length, "workspace"),
					stat: "Alerts & agent ready",
					lastSync: null,
					issue: null,
				}
			},
			unavailableOverview,
		),
}
