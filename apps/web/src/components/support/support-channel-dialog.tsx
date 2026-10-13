import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { SlackIcon } from "@/components/icons"
import { SupportChannelBody } from "@/components/support/support-channel-body"

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
