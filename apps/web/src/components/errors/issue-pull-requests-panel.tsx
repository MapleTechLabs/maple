import type { ErrorIssuePullRequestDocument } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemMedia } from "@maple/ui/components/ui/item"
import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import { cn } from "@maple/ui/lib/utils"

import { DocsLink } from "@/components/common/docs-link"
import { GithubIcon, PlusIcon, TrashIcon } from "@/components/icons"
import { AttachPullRequestDialog, PULL_REQUEST_STATE_TONE } from "./attach-pull-request-dialog"

/**
 * Pull requests attached to this issue.
 *
 * The link is what turns a fix into something Maple can follow up on: when a
 * listed PR merges, a verification window opens and the issue is checked
 * against real traffic rather than waiting for someone to remember it. The
 * panel says so on the empty state, because "attach a PR" is otherwise a
 * chore with no visible payoff.
 */

const SOURCE_HINT: Record<ErrorIssuePullRequestDocument["linkSource"], string | null> = {
	user: null,
	agent: "attached by an agent",
	auto: "found in the pull request description",
} satisfies Record<ErrorIssuePullRequestDocument["linkSource"], string | null>

export function IssuePullRequestsPanel({
	pullRequests,
	suggestedRepository,
	onLink,
	onUnlink,
	busy = false,
	open,
	onOpenChange,
}: {
	pullRequests: ReadonlyArray<ErrorIssuePullRequestDocument>
	suggestedRepository: string | null
	onLink: (url: string) => Promise<boolean>
	onUnlink: (id: ErrorIssuePullRequestDocument["id"]) => void
	busy?: boolean
	/** Controlled so the verification card and the `in_review` transition can open it too. */
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	return (
		<Panel>
			<PanelHeader
				title="Pull requests"
				action={
					<Button
						size="sm"
						variant="ghost"
						className="h-7 gap-1 px-2 text-xs"
						onClick={() => onOpenChange(true)}
						disabled={busy}
					>
						<PlusIcon className="size-3.5" />
						Attach
					</Button>
				}
			/>

			{pullRequests.length === 0 ? (
				<div className="space-y-2 px-4 py-3">
					<p className="text-xs text-muted-foreground">
						Attach the pull request that fixes this. When it merges, Maple watches for the error
						to come back and closes this issue if it doesn&apos;t.
					</p>
					<DocsLink page="github">GitHub integration docs</DocsLink>
				</div>
			) : (
				<ul className="divide-y">
					{pullRequests.map((pr) => {
						const hint = SOURCE_HINT[pr.linkSource]
						return (
							<Item
								key={pr.id}
								render={<li />}
								variant="flush"
								size="lg"
								className="group flex-nowrap items-start"
							>
								<ItemMedia variant="icon" className="text-muted-foreground">
									<GithubIcon className="size-4" />
								</ItemMedia>
								<ItemContent>
									<div className="flex flex-wrap items-center gap-2">
										<a
											href={pr.url}
											target="_blank"
											rel="noreferrer"
											className="truncate text-sm font-medium text-foreground hover:underline"
										>
											{pr.repoFullName}#{pr.number}
										</a>
										<Badge
											variant="outline"
											className={cn(
												"shrink-0 capitalize",
												PULL_REQUEST_STATE_TONE[pr.state],
											)}
										>
											{pr.state}
										</Badge>
									</div>
									{pr.title ? (
										<ItemDescription className="line-clamp-1">{pr.title}</ItemDescription>
									) : null}
									{hint ? (
										<ItemDescription className="text-muted-foreground/80">
											{hint}
										</ItemDescription>
									) : null}
								</ItemContent>
								<Button
									size="icon"
									variant="ghost"
									aria-label={`Detach ${pr.repoFullName}#${pr.number}`}
									className="size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
									onClick={() => onUnlink(pr.id)}
									disabled={busy}
								>
									<TrashIcon className="size-3.5" />
								</Button>
							</Item>
						)
					})}
				</ul>
			)}

			<AttachPullRequestDialog
				open={open}
				onOpenChange={onOpenChange}
				suggestedRepository={suggestedRepository}
				onAttach={onLink}
				busy={busy}
			/>
		</Panel>
	)
}
