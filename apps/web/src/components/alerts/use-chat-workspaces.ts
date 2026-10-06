import { Exit } from "effect"
import { useRef, useState } from "react"
import type { ChatConnectorId, ChatWorkspaceId } from "@maple/domain/primitives"
import type { V2ChatConnector } from "@maple/domain/http/v2"

import { useOAuthPopupFlow } from "@/components/integrations/integration-connect"
import { useChatConnectorGate } from "@/hooks/use-organization-feature-flags"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"

export interface LinkedChatWorkspace {
	readonly connector: ChatConnectorId
	readonly id: ChatWorkspaceId
	readonly name: string
}

const connectorsQuery = () =>
	retainedQueryV2("chatIntegration", "connectors", { reactivityKeys: ["chatIntegration"] })

/** The chat connectors this org may use, Slack first, with their linked workspaces. Empty until the list answers. */
export function useChatConnectors(): ReadonlyArray<V2ChatConnector> {
	const gate = useChatConnectorGate()
	const result = useAtomValue(connectorsQuery())
	return Result.builder(result)
		.onSuccess((response) =>
			response.data
				.filter((connector) => gate(connector.id))
				.sort((a, b) => Number(b.id === "slack") - Number(a.id === "slack")),
		)
		.orElse(() => [])
}

/**
 * Links a chat workspace in a popup so the page underneath (a half-written rule) survives. The
 * install callback lands on /integrations inside the popup; polling the connector list is what
 * notices the new workspace, closes the popup and hands the workspace back.
 */
export function useChatWorkspaceConnect({
	onLinked,
}: {
	onLinked: (workspace: LinkedChatWorkspace) => void
}) {
	const atom = connectorsQuery()
	const result = useAtomValue(atom)
	const refresh = useAtomRefresh(atom)
	const install = useAtomSet(MapleApiV2AtomClient.mutation("chatIntegration", "install"), {
		mode: "promiseExit",
	})
	// Set in the click, read by `start` in the same tick, before any re-render could carry it.
	const startingRef = useRef<ChatConnectorId | null>(null)
	const [starting, setStarting] = useState<ChatConnectorId | null>(null)
	// Workspaces that existed when the popup opened; anything else in the list is the new link.
	const [pending, setPending] = useState<{
		connector: ChatConnectorId
		knownIds: ReadonlySet<string>
	} | null>(null)
	const connectors = Result.builder(result)
		.onSuccess((response) => response.data)
		.orElse(() => [])

	const flow = useOAuthPopupFlow({
		windowName: "maple-chat-connect",
		windowFeatures: "popup,width=640,height=760",
		label: "chat",
		start: async () => {
			const connector = startingRef.current
			if (connector === null) return Exit.die("chat connect started without a connector")
			const existing = connectors.find((entry) => entry.id === connector)?.workspaces ?? []
			setPending({ connector, knownIds: new Set(existing.map((workspace) => workspace.id)) })
			const started = await install({ params: { connector }, reactivityKeys: ["chatIntegration"] })
			return Exit.map(started, (response) => ({ redirectUrl: response.url }))
		},
		startErrorTitle: "Failed to start the install",
		onPoll: () => {
			const linked =
				pending === null
					? undefined
					: connectors
							.find((entry) => entry.id === pending.connector)
							?.workspaces.find((workspace) => !pending.knownIds.has(workspace.id))
			if (pending === null || linked === undefined) {
				refresh()
				return
			}
			setPending(null)
			flow.closePopup()
			onLinked({ connector: pending.connector, id: linked.id, name: linked.name })
		},
		onClosed: refresh,
		// Slack's consent page can sever the opener, so the popup reads as closed while the user is
		// still authorizing. Keep polling long enough for a slow consent to land.
		closeGraceMs: 5 * 60_000,
	})

	return {
		connect: (connector: V2ChatConnector) => {
			startingRef.current = connector.id
			setStarting(connector.id)
			flow.connect(connector.name)
		},
		/** The connector whose popup is out, if any. */
		waitingFor: flow.busy || flow.popupActive ? starting : null,
	}
}
