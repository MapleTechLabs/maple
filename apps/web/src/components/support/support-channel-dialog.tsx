import { useState } from "react"
import { useUser } from "@clerk/clerk-react"
import { Exit } from "effect"
import type { V2SupportChannel } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { ExternalLinkIcon, SlackIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { trackProduct } from "@/lib/analytics"
import { displayError } from "@/lib/error-messages"
import {
	inviteToSupportChannelMutation,
	supportChannelAtom,
} from "@/lib/services/atoms/support-channel-atoms"

interface SupportChannelDialogProps {
	readonly open: boolean
	readonly onOpenChange: (open: boolean) => void
}

/**
 * One button between a customer and a shared Slack channel with the Maple team. The first press
 * creates the channel; every press sends the presser a Slack Connect invite, so each teammate can
 * join on their own.
 */
export function SupportChannelDialog({ open, onOpenChange }: SupportChannelDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<SlackIcon size={18} />
						Shared Slack channel
					</DialogTitle>
					<DialogDescription>
						A private channel between your team and the people who build Maple, in your own Slack
						workspace.
					</DialogDescription>
				</DialogHeader>
				{/* Mounted only while open, so the sidebar never fetches the channel by itself. */}
				{open ? <SupportChannelBody /> : null}
			</DialogContent>
		</Dialog>
	)
}

function SupportChannelBody() {
	const { user } = useUser()
	const email = user?.primaryEmailAddress?.emailAddress ?? null
	const channelAtom = supportChannelAtom()
	const result = useAtomValue(channelAtom)
	const refresh = useAtomRefresh(channelAtom)
	const runInvite = useAtomSet(inviteToSupportChannelMutation, { mode: "promiseExit" })
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [invited, setInvited] = useState<V2SupportChannel | null>(null)

	async function invite() {
		setPending(true)
		setError(null)
		const exit = await runInvite({})
		setPending(false)
		if (Exit.isSuccess(exit)) {
			trackProduct("support_channel_invite_sent")
			setInvited(exit.value)
			refresh()
			return
		}
		setError(displayError(exit).message)
	}

	if (invited !== null) {
		return (
			<>
				<DialogPanel>
					<p className="text-sm">
						Invite sent to <span className="font-medium">{invited.invited_email}</span>. Open the
						email or Slack and accept it to add{" "}
						<span className="font-mono">#{invited.channel_name}</span> to your workspace.
					</p>
				</DialogPanel>
				{invited.slack_url ? (
					<DialogFooter>
						<OpenInSlack url={invited.slack_url} />
					</DialogFooter>
				) : null}
			</>
		)
	}

	if (Result.isFailure(result)) {
		return (
			<DialogPanel>
				<p className="text-sm text-destructive">{displayError(result.cause).message}</p>
			</DialogPanel>
		)
	}
	if (!Result.isSuccess(result)) {
		return (
			<DialogPanel className="space-y-2">
				<Skeleton className="h-4 w-full" />
				<Skeleton className="h-4 w-2/3" />
			</DialogPanel>
		)
	}

	const channel = result.value
	if (channel.status === "unavailable") {
		return (
			<DialogPanel>
				<p className="text-sm text-muted-foreground">
					Shared Slack channels are not set up on this Maple instance. Email{" "}
					<a className="underline" href="mailto:support@maple.dev">
						support@maple.dev
					</a>{" "}
					and we will get back to you.
				</p>
			</DialogPanel>
		)
	}

	const target = email ? <span className="font-medium">{email}</span> : "your email"
	return (
		<>
			<DialogPanel className="space-y-3">
				{channel.status === "active" ? (
					<p className="text-sm">
						Your team's channel is <span className="font-mono">#{channel.channel_name}</span>. We
						will send a Slack Connect invite to {target} so you can join it.
					</p>
				) : (
					<p className="text-sm">
						We will create the channel and send a Slack Connect invite to {target}. Accept it in
						Slack and the channel shows up in your workspace. Teammates can join the same way from
						here.
					</p>
				)}
				{error ? <p className="text-sm text-destructive">{error}</p> : null}
			</DialogPanel>
			<DialogFooter>
				{channel.status === "active" && channel.slack_url ? (
					<OpenInSlack url={channel.slack_url} />
				) : null}
				<Button onClick={() => void invite()} disabled={pending}>
					{pending
						? "Sending invite..."
						: channel.status === "active"
							? "Send me an invite"
							: "Create channel"}
				</Button>
			</DialogFooter>
		</>
	)
}

function OpenInSlack({ url }: { url: string }) {
	return (
		<Button
			variant="outline"
			render={<a aria-label="Open in Slack" href={url} target="_blank" rel="noopener noreferrer" />}
		>
			Open in Slack
			<ExternalLinkIcon size={14} />
		</Button>
	)
}
