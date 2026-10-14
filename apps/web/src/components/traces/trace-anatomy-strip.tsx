import {
	TraceAnatomyStrip as SharedTraceAnatomyStrip,
	type TraceAnatomyStripProps,
} from "@maple/ui/components/traces/trace-anatomy-strip"
import { shortId } from "@maple/ui/lib/ids"
import { CommitShaHoverCard } from "@/components/vcs/commit-sha-hover-card"

/** The shared strip, with the root's commit SHA linked to the connected VCS provider. */
export function TraceAnatomyStrip({
	commitSha,
	...props
}: Omit<TraceAnatomyStripProps, "commit"> & { commitSha?: string }) {
	return (
		<SharedTraceAnatomyStrip
			{...props}
			commit={
				commitSha ? (
					<CommitShaHoverCard
						sha={commitSha}
						copy={{ value: commitSha, label: "commit SHA" }}
						className="font-mono text-xs text-muted-foreground hover:text-foreground"
					>
						{shortId(commitSha, "sha")}
					</CommitShaHoverCard>
				) : undefined
			}
		/>
	)
}
