import { useState } from "react"
import { useReverification, useSession, useUser } from "@clerk/clerk-react"
import type { SessionWithActivities } from "@/components/account/account-types"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	TruncatedCell,
} from "@maple/ui/components/ui/table"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { ComputerIcon, MobileIcon } from "@/components/icons"
import { RelativeTime } from "@/components/common/relative-time"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { accountErrorMessage, settleClerk } from "@/components/account/account-errors"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { useAsyncAction } from "@/hooks/use-mutation-action"

type LoadState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; sessions: ReadonlyArray<SessionWithActivities> }

function describeDevice(session: SessionWithActivities): string {
	const { browserName, browserVersion, deviceType } = session.latestActivity
	const browser = [browserName, browserVersion].filter(Boolean).join(" ")
	return [deviceType, browser].filter(Boolean).join(" · ") || "Unknown device"
}

function describeLocation(session: SessionWithActivities): string {
	const { city, country, ipAddress } = session.latestActivity
	return [city, country].filter(Boolean).join(", ") || ipAddress || "Unknown location"
}

export function ActiveSessionsSection() {
	const { user, isLoaded } = useUser()
	const { session: currentSession } = useSession()

	const [state, setState] = useState<LoadState>({ status: "loading" })
	const [pendingRevoke, setPendingRevoke] = useState<SessionWithActivities | null>(null)
	const [withRevoking, isRevoking] = useAsyncAction((task: () => Promise<void>) => task())

	const revokeSession = useReverification((session: SessionWithActivities) => session.revoke())

	// `user.getSessions()` is imperative (Clerk exposes no hook for other-device sessions), so
	// this is the sanctioned mount-effect escape hatch rather than a `useEffect`.
	useMountEffect(() => {
		void load()
	})

	function load() {
		if (!user) return Promise.resolve()
		return user.getSessions().then(
			(sessions) => setState({ status: "ready", sessions }),
			(err: unknown) =>
				setState({
					status: "error",
					message: accountErrorMessage(err, "Failed to load your sessions"),
				}),
		)
	}

	function handleRevoke() {
		if (!pendingRevoke) return
		const session = pendingRevoke
		return withRevoking(async () => {
			const ok = await settleClerk(revokeSession(session), {
				success: "Session signed out",
				error: "Failed to sign out that session",
			})
			if (!ok) return
			setPendingRevoke(null)
			// `revoke()` returns only the one session, so refetch rather than patching state and
			// risking a list that disagrees with Clerk about what is still active.
			await load()
		})
	}

	return (
		<SettingsSections>
			<SettingsSection
				title="Active sessions"
				description="Devices currently signed in to your account. Sign out any you do not recognise."
				padded={!isLoaded || state.status !== "ready"}
			>
				{!isLoaded || state.status === "loading" ? (
					<SkeletonList rows={2} rowClassName="h-9" gap="2" />
				) : state.status === "error" ? (
					<div className="flex items-center justify-between gap-4">
						<p className={cn("text-sm", TONE_TEXT.crit)}>{state.message}</p>
						<Button variant="outline" size="sm" onClick={() => void load()}>
							Retry
						</Button>
					</div>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Device</TableHead>
								<TableHead className="hidden sm:table-cell">Location</TableHead>
								<TableHead>Last active</TableHead>
								<TableHead className="w-24" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{state.sessions.map((session) => {
								const isCurrent = session.id === currentSession?.id
								const DeviceIcon = session.latestActivity.isMobile ? MobileIcon : ComputerIcon

								return (
									<TableRow key={session.id}>
										<TruncatedCell>
											<div className="flex items-center gap-2.5">
												<DeviceIcon
													size={16}
													className="shrink-0 text-muted-foreground"
												/>
												<TruncatedText
													text={describeDevice(session)}
													className="text-xs font-medium"
												/>
												{isCurrent && (
													<Badge variant="secondary" className="shrink-0">
														This device
													</Badge>
												)}
											</div>
										</TruncatedCell>
										<TableCell className="text-muted-foreground hidden text-xs sm:table-cell">
											{describeLocation(session)}
										</TableCell>
										<TableCell className="text-muted-foreground text-xs">
											<RelativeTime value={session.lastActiveAt} />
										</TableCell>
										<TableCell>
											{/* Revoking the current session would sign the user out from
												    inside the page they are using; use Log out for that. */}
											{!isCurrent && (
												<Button
													variant="ghost"
													size="sm"
													onClick={() => setPendingRevoke(session)}
												>
													Sign out
												</Button>
											)}
										</TableCell>
									</TableRow>
								)
							})}
						</TableBody>
					</Table>
				)}
			</SettingsSection>

			<ConfirmDialog
				open={pendingRevoke !== null}
				onOpenChange={(open) => {
					if (!open) setPendingRevoke(null)
				}}
				title="Sign out this device?"
				description={`${pendingRevoke ? describeDevice(pendingRevoke) : "This session"} will need to sign in again to reach Maple.`}
				confirmLabel="Sign out"
				pending={isRevoking}
				onConfirm={() => void handleRevoke()}
			/>
		</SettingsSections>
	)
}
