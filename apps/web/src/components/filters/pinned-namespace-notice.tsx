import { useRouter } from "@tanstack/react-router"
import { LayersIcon } from "@/components/icons"
import { eyebrowVariants } from "@maple/ui/components/ui/eyebrow"
import { cn } from "@maple/ui/lib/utils"
import { Badge } from "@maple/ui/components/ui/badge"
import { setGlobalNamespace } from "@/lib/services/common/global-namespace"

/**
 * Replaces a sidebar's Namespace filter section while the org-global namespace
 * pin is active — the page-level filter is ignored (not rewritten) until the
 * pin is cleared here or in the org menu. Styled as a regular section so it
 * reads as part of the sidebar, not a callout.
 */
export function PinnedNamespaceNotice({ namespace }: { namespace: string }) {
	const router = useRouter()

	return (
		<div>
			<div
				className={cn(
					"flex w-full items-center justify-between gap-2 py-2 text-muted-foreground",
					eyebrowVariants({ variant: "label" }),
				)}
			>
				<span className="truncate">Namespace</span>
				<button
					type="button"
					className="font-medium normal-case tracking-normal text-muted-foreground transition-colors hover:text-foreground"
					onClick={() => {
						setGlobalNamespace(null)
						void router.invalidate()
					}}
				>
					Clear
				</button>
			</div>
			<div className="flex items-center gap-2 py-1 text-sm">
				<LayersIcon size={14} className="shrink-0 text-muted-foreground" />
				<span className="truncate">{namespace}</span>
				<Badge variant="tag" title="Pinned for the whole app in the org menu" className="ml-auto">
					Pinned
				</Badge>
			</div>
		</div>
	)
}
