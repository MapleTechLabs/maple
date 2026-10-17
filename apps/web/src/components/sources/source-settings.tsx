import type { V2Source, V2SourceUpdateParams } from "@maple/domain/http/v2"
import { Button } from "@maple/ui/components/ui/button"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import { Input } from "@maple/ui/components/ui/input"
import { Textarea } from "@maple/ui/components/ui/textarea"
import { useState } from "react"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { useAtomRefresh, useAtomSet } from "@/lib/effect-atom"
import { toastExit } from "@/lib/error-toast"
import { sourcesListAtom } from "@/lib/services/atoms/sources-atoms"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { useRulesDraft } from "./rules-draft"
import { RulesFields } from "./rules-fields"
import { rulesOutcome } from "./rules-payload"

/** Name, description and rules. The default source only takes a name and description. */
export function SourceSettings({ source }: { source: V2Source }) {
	const refresh = useAtomRefresh(sourcesListAtom)
	const update = useAtomSet(MapleApiV2AtomClient.mutation("sources", "update"), { mode: "promiseExit" })
	const [name, setName] = useState(source.name)
	const [description, setDescription] = useState(source.description ?? "")
	const draft = useRulesDraft(source)
	const rules = rulesOutcome(draft)
	const valid = name.trim().length > 0 && (source.is_default || rules.valid)

	const [save, saving] = useAsyncAction(async () => {
		if (!valid) return
		const basics: V2SourceUpdateParams = {
			name: name.trim(),
			description: description.trim().length > 0 ? description.trim() : null,
		}
		const withRules: V2SourceUpdateParams = { ...basics, ...rules.payload }
		const payload: V2SourceUpdateParams = source.is_default
			? basics
			: rules.expiresAt === undefined
				? withRules
				: { ...withRules, expires_at: rules.expiresAt }
		const result = await update({ params: { id: source.id }, payload })
		if (
			toastExit(result, {
				success: "Source saved. Changes reach the gateway within a minute.",
				error: "Failed to save source",
			})
		)
			refresh()
	})

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault()
				void save()
			}}
		>
			<SettingsSections>
				<SettingsSection title="General">
					<div className="flex flex-col gap-4">
						<Field>
							<FieldLabel htmlFor="source-settings-name">Name</FieldLabel>
							<Input
								id="source-settings-name"
								value={name}
								maxLength={100}
								onChange={(event) => setName(event.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="source-settings-description">
								Description{" "}
								<span className="text-muted-foreground font-normal">(optional)</span>
							</FieldLabel>
							<Textarea
								id="source-settings-description"
								value={description}
								maxLength={500}
								onChange={(event) => setDescription(event.target.value)}
							/>
						</Field>
					</div>
				</SettingsSection>
				<SettingsSection
					title="Rules"
					description={
						source.is_default
							? "The default source stands for your organization's ingest keys and has no rules. Create a source to limit signals, cap the rate or stamp attributes."
							: "Applied by the ingest gateway to everything this source sends."
					}
				>
					<RulesFields draft={draft} disabled={source.is_default} />
				</SettingsSection>
				<div className="flex justify-end">
					<Button type="submit" disabled={!valid} loading={saving}>
						Save changes
					</Button>
				</div>
			</SettingsSections>
		</form>
	)
}
