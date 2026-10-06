import { Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Item, ItemContent, ItemMedia } from "@maple/ui/components/ui/item"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { ErrorState } from "@/components/common/error-state"
import { HazelIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient, retainedQuery } from "@/lib/services/common/atom-client"
import { HAZEL_ACCENT, IntegrationIconPlate } from "./integration-catalog"
import { useRequiredIntegrationConnect } from "./integration-connect"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"
import { useIntegrationDisconnect } from "./use-integration-disconnect"

export function HazelIntegrationCard() {
	const statusAtom = retainedQuery("integrations", "hazelStatus", {
		reactivityKeys: ["hazelIntegrationStatus"],
	})
	const statusResult = useAtomValue(statusAtom)
	const refreshStatus = useAtomRefresh(statusAtom)

	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "hazelDisconnect"), {
		mode: "promiseExit",
	})

	// Connect flow (popup, busy, refresh-on-return) lives in IntegrationConnectProvider —
	// shared with the drill-in header's Connect button.
	const connectFlow = useRequiredIntegrationConnect("HazelIntegrationCard")
	const { disconnect: handleDisconnect, pending: disconnectBusy } = useIntegrationDisconnect(
		() => disconnect({ reactivityKeys: ["hazelIntegrationStatus", "hazelWorkspaces"] }),
		{ success: "Hazel disconnected", error: "Failed to disconnect Hazel" },
	)
	const actionBusy = connectFlow.busy || disconnectBusy

	// Keep the last loaded status if a refetch fails.
	const status = Option.getOrNull(AsyncResult.value(statusResult))
	const isLoading = Result.isInitial(statusResult) && status === null
	const loadFailed = Result.isFailure(statusResult) && status === null

	const isConnected = status?.connected === true
	if (isLoading) {
		return <Skeleton className="h-32 w-full rounded-lg" />
	}
	if (loadFailed) {
		return (
			<ErrorState
				error={statusResult.cause}
				title="Failed to load the Hazel integration"
				onRetry={refreshStatus}
			/>
		)
	}

	if (!isConnected) {
		return (
			<IntegrationEmpty icon={HazelIcon} accent={HAZEL_ACCENT}>
				<IntegrationEmptyFeatures>
					<IntegrationEmptyFeature
						label="Alert delivery"
						title="Alerts post to Hazel"
						description="Fired alerts land straight in the channel you pick."
					/>
					<IntegrationEmptyFeature
						label="Channel routing"
						title="Workspace per destination"
						description="Each destination picks the workspace and channel that gets notified."
					/>
					<IntegrationEmptyFeature
						label="Escalations"
						title="A step in your policies"
						description="Use Hazel as a delivery step inside escalation chains."
					/>
				</IntegrationEmptyFeatures>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>
						Alert destinations will appear here after connecting your workspace.
					</IntegrationEmptyHint>
					<Button onClick={connectFlow.connect} disabled={actionBusy} loading={connectFlow.busy}>
						<HazelIcon size={16} />
						Connect Hazel
					</Button>
					<IntegrationEmptyFooter>
						You'll authorize Maple in your Hazel workspace.
					</IntegrationEmptyFooter>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
		)
	}

	return (
		<Item variant="card" className="items-start gap-4 p-4">
			<ItemMedia>
				<IntegrationIconPlate icon={HazelIcon} accent={HAZEL_ACCENT} />
			</ItemMedia>

			<ItemContent className="gap-2">
				<div>
					<div className="flex items-center gap-2">
						<h3 className="text-sm font-semibold">Hazel</h3>
						<Badge variant="success">Connected</Badge>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						Forward Maple alerts into a Hazel workspace via OAuth. Once connected, create a Hazel
						destination to pick which workspace receives notifications.
					</p>
				</div>

				{status ? (
					<div className="flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
						{status.externalUserEmail ? (
							<div>
								<span className="text-foreground">{status.externalUserEmail}</span> authorized
								this connection.
							</div>
						) : status.externalUserId ? (
							<div>External account: {status.externalUserId}</div>
						) : null}
						{status.scope ? <div>Scopes: {status.scope}</div> : null}
					</div>
				) : null}

				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="outline"
						onClick={connectFlow.connect}
						disabled={actionBusy}
						loading={connectFlow.busy}
					>
						Reconnect
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={handleDisconnect}
						disabled={actionBusy}
						loading={disconnectBusy}
					>
						Disconnect
					</Button>
				</div>
			</ItemContent>
		</Item>
	)
}
