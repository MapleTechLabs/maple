import { Fragment } from "react"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Kbd, KbdGroup } from "@maple/ui/components/ui/kbd"
import {
	allShortcutIds,
	SHORTCUT_GROUPS,
	type ShortcutId,
	shortcutDef,
	shortcutDisplayAlternates,
} from "@/lib/shortcuts"

function ShortcutRow({ id }: { id: ShortcutId }) {
	const alternates = shortcutDisplayAlternates(id)
	return (
		<div className="flex items-center justify-between gap-4 py-1.5">
			<span className="text-sm">{shortcutDef(id).label}</span>
			<span className="flex shrink-0 items-center gap-1.5">
				{alternates.map((tokens, index) => (
					<Fragment key={tokens.join("+")}>
						{index > 0 && <span className="text-muted-foreground text-xs">or</span>}
						<KbdGroup>
							{tokens.map((token) => (
								<Kbd key={token}>{token}</Kbd>
							))}
						</KbdGroup>
					</Fragment>
				))}
			</span>
		</div>
	)
}

export function KeyboardShortcutsDialog({
	open,
	onOpenChange,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const ids = allShortcutIds()
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>
						Available across Maple — press ? anywhere to open this list.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<div className="space-y-4">
						{SHORTCUT_GROUPS.map((group) => {
							const groupIds = ids.filter((id) => shortcutDef(id).group === group)
							if (groupIds.length === 0) return null
							return (
								<div key={group}>
									<h3 className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">
										{group}
									</h3>
									<div className="divide-y divide-border/50">
										{groupIds.map((id) => (
											<ShortcutRow key={id} id={id} />
										))}
									</div>
								</div>
							)
						})}
					</div>
				</DialogPanel>
			</DialogContent>
		</Dialog>
	)
}
