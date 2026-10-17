import type { V2Source } from "@maple/domain/http/v2"
import type { PushSourcePlatform } from "@maple/domain/primitives"
import { Button } from "@maple/ui/components/ui/button"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@maple/ui/components/ui/collapsible"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import { Input } from "@maple/ui/components/ui/input"
import { Panel } from "@maple/ui/components/ui/panel"
import { useState } from "react"
import { ChevronRightIcon } from "@/components/icons"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useAtomRefresh, useAtomSet } from "@/lib/effect-atom"
import { toastExit } from "@/lib/error-toast"
import { sourcesListAtom } from "@/lib/services/atoms/sources-atoms"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { defaultSourceName, PlatformTile, platformMeta } from "./platforms"
import { useRulesDraft } from "./rules-draft"
import { RulesFields } from "./rules-fields"
import { rulesOutcome } from "./rules-payload"
import type { RevealedToken } from "./shared"

/** Step 2: a name, and optional rules folded under "Advanced". */
export function CreateSourceForm({
	platform,
	onBack,
	onCreated,
}: {
	platform: PushSourcePlatform
	onBack: () => void
	onCreated: (source: V2Source, revealed: RevealedToken) => void
}) {
	const refreshSources = useAtomRefresh(sourcesListAtom)
	const createMutation = useAtomSet(MapleApiV2AtomClient.mutation("sources", "create"), {
		mode: "promiseExit",
	})
	const [name, setName] = useState(defaultSourceName(platform))
	const draft = useRulesDraft(null)
	const rules = rulesOutcome(draft)
	const valid = name.trim().length > 0 && rules.valid

	const [submit, saving] = useAsyncAction(async () => {
		if (!valid) return
		const result = await createMutation({
			payload: {
				name: name.trim(),
				platform,
				...rules.payload,
				expires_at: rules.expiresAt ?? null,
			},
		})
		if (!toastExit(result, { error: "Failed to create source" })) return
		refreshSources()
		if (result._tag === "Success") {
			const { secret, ...source } = result.value
			onCreated(source, { sourceId: source.id, secret, rolled: false })
		}
	})

	return (
		<form
			className="flex w-full max-w-2xl flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault()
				void submit()
			}}
		>
			<Panel padded className="gap-4">
				<div className="flex items-center gap-3">
					<PlatformTile platform={platform} />
					<div className="flex min-w-0 flex-col">
						<span className="text-sm font-medium">{platformMeta(platform).label}</span>
						<span className="text-muted-foreground text-xs">
							{platformMeta(platform).description}
						</span>
					</div>
				</div>
				<Field>
					<FieldLabel htmlFor="source-name">Name</FieldLabel>
					<Input
						id="source-name"
						value={name}
						maxLength={100}
						onChange={(event) => setName(event.target.value)}
					/>
				</Field>
			</Panel>
			<Collapsible>
				<CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1.5 text-sm">
					<ChevronRightIcon
						size={14}
						className="transition-transform group-data-[panel-open]:rotate-90"
					/>
					Advanced
				</CollapsibleTrigger>
				<CollapsiblePanel>
					<Panel padded className="mt-3">
						<RulesFields draft={draft} />
					</Panel>
				</CollapsiblePanel>
			</Collapsible>
			<footer className="flex items-center gap-3 border-t pt-4">
				<span className="text-muted-foreground grow text-xs">
					The token is shown once, on the next step.
				</span>
				<Button type="button" variant="outline" onClick={onBack}>
					Back
				</Button>
				<Button type="submit" disabled={!valid} loading={saving}>
					Create source
				</Button>
			</footer>
		</form>
	)
}
