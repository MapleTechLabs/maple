import type { PushSourcePlatform, SourcePlatform } from "@maple/domain/primitives"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { cn } from "@maple/ui/lib/utils"
import { ChevronRightIcon } from "@/components/icons"
import { PLATFORMS, PlatformTile, PULL_PLATFORMS, PUSH_PLATFORMS } from "./platforms"

type PullPlatform = (typeof PULL_PLATFORMS)[number]

function PlatformCard({ platform, onSelect }: { platform: SourcePlatform; onSelect: () => void }) {
	const meta = PLATFORMS[platform]
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"group bg-card flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors",
				"hover:bg-muted/40 focus-visible:ring-ring outline-none focus-visible:ring-2",
			)}
		>
			<PlatformTile platform={platform} />
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-sm font-medium">{meta.label}</span>
				<span className="text-muted-foreground truncate text-xs">{meta.description}</span>
			</span>
			<ChevronRightIcon
				size={14}
				className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
			/>
		</button>
	)
}

/** Step 1: push platforms create a source here, pull platforms open their integration. */
export function PlatformPicker({
	onSelectPush,
	onSelectPull,
}: {
	onSelectPush: (platform: PushSourcePlatform) => void
	onSelectPull: (platform: PullPlatform) => void
}) {
	return (
		<div className="flex flex-col gap-8">
			<section className="flex flex-col gap-3">
				<Eyebrow>Send with OpenTelemetry</Eyebrow>
				<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
					{PUSH_PLATFORMS.map((platform) => (
						<PlatformCard
							key={platform}
							platform={platform}
							onSelect={() => onSelectPush(platform)}
						/>
					))}
				</div>
			</section>
			<section className="flex flex-col gap-3">
				<Eyebrow>Connect an integration</Eyebrow>
				<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
					{PULL_PLATFORMS.map((platform) => (
						<PlatformCard
							key={platform}
							platform={platform}
							onSelect={() => onSelectPull(platform)}
						/>
					))}
				</div>
			</section>
		</div>
	)
}
