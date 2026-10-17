import { useState } from "react"
import type { V2McpConnection } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { RelativeTime } from "@/components/common/relative-time"
import { SettingsSection } from "@/components/settings/settings-section"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { toastExit } from "@/lib/error-toast"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { formatDateInTimezone } from "@/lib/timezone-format"

function ConnectionRow({
	connection,
	timeZone,
	onRevoke,
}: {
	connection: V2McpConnection
	timeZone: string
	onRevoke: () => void
}) {
	return (
		<li className="flex items-center gap-4 px-4 py-3">
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium">{connection.client_name}</p>
				<p className="truncate text-xs text-muted-foreground">
					{connection.user_email ?? connection.user_id}
				</p>
			</div>
			<p className="hidden shrink-0 text-xs text-muted-foreground sm:block">
				Connected {formatDateInTimezone(connection.connected_at, { timeZone })}
			</p>
			<p className="hidden shrink-0 text-xs text-muted-foreground md:block">
				Last refreshed <RelativeTime value={connection.last_refreshed_at} />
			</p>
			<Button variant="ghost" size="sm" className="shrink-0 text-destructive" onClick={onRevoke}>
				Revoke
			</Button>
		</li>
	)
}

export function McpConnectedClientsSection() {
	const isAdmin = useIsOrgAdmin()
	const { effectiveTimezone } = useTimezonePreference()
	const listAtom = retainedQueryV2("mcpConnections", "list", { query: { limit: 100 } })
	const result = useAtomValue(listAtom)
	const refresh = useAtomRefresh(listAtom)
	const revokeMutation = useAtomSet(MapleApiV2AtomClient.mutation("mcpConnections", "revoke"), {
		mode: "promiseExit",
	})
	const [revoking, setRevoking] = useState<V2McpConnection | null>(null)
	const [confirmOpen, setConfirmOpen] = useState(false)

	async function handleRevoke(): Promise<boolean> {
		if (revoking === null) return false
		const exit = await revokeMutation({ params: { id: revoking.id } })
		const ok = toastExit(exit, { success: "Client signed out", error: "Failed to revoke the client" })
		if (ok) refresh()
		return ok
	}

	const content = Result.builder(result)
		.onSuccess((page) =>
			page.data.length === 0 ? (
				<p className="px-4 py-6 text-center text-sm text-muted-foreground">
					No clients connected yet. Connect one above.
				</p>
			) : (
				<ul className="divide-y">
					{page.data.map((connection) => (
						<ConnectionRow
							key={connection.id}
							connection={connection}
							timeZone={effectiveTimezone}
							onRevoke={() => {
								setRevoking(connection)
								setConfirmOpen(true)
							}}
						/>
					))}
				</ul>
			),
		)
		.onError(() => (
			<p className="px-4 py-6 text-center text-sm text-muted-foreground">
				Connected clients could not be loaded.
			</p>
		))
		.orElse(() => (
			<div className="p-4">
				<SkeletonList rows={2} />
			</div>
		))

	return (
		<SettingsSection
			title="Connected clients"
			description={
				isAdmin
					? "Clients members approved with OAuth. Revoking signs the client out right away."
					: "Clients you approved with OAuth. Revoking signs the client out right away."
			}
			padded={false}
		>
			{content}
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Revoke this client?"
				description={
					revoking ? (
						<>
							<span className="font-medium text-foreground">{revoking.client_name}</span> loses
							access right away and has to be approved again to reconnect.
						</>
					) : null
				}
				confirmLabel="Revoke"
				onConfirm={handleRevoke}
			/>
		</SettingsSection>
	)
}
