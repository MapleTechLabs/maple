import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"

import { Schema } from "effect"

import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import {
	IssueEscalationPolicyRule,
	IssueEscalationPolicyUpsertRequest,
	type EscalationConfidence,
	type IssueSeverity,
} from "@maple/domain/http"
import { AlertDestinationId } from "@maple/domain/primitives"

const decodeDestinationIds = Schema.decodeUnknownSync(Schema.Array(AlertDestinationId))

import { Button } from "@maple/ui/components/ui/button"
import { Panel } from "@maple/ui/components/ui/panel"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { SettingRow } from "@maple/ui/components/ui/setting-row"
import { Switch } from "@maple/ui/components/ui/switch"

import { MultiSegmentedSelect, type SegmentedOption } from "@/components/common/segmented-select"
import { destinationProvider, ProviderLogo } from "@/components/alerts/destination-provider"
import { SeverityBadge, SEVERITY_ORDER } from "@/components/errors/severity-badge"
import { DocsLink } from "@/components/common/docs-link"
import { ErrorState } from "@/components/common/error-state"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"

const CONFIDENCE_ANY = "any" as const
const CONFIDENCE_CHOICES = [CONFIDENCE_ANY, "low", "medium", "high"] as const

interface SeverityRuleDraft {
	destinationIds: string[]
	minConfidence: EscalationConfidence | typeof CONFIDENCE_ANY
}

type DraftRules = Record<IssueSeverity, SeverityRuleDraft>

const emptyDraft = (): DraftRules => ({
	critical: { destinationIds: [], minConfidence: CONFIDENCE_ANY },
	high: { destinationIds: [], minConfidence: CONFIDENCE_ANY },
	medium: { destinationIds: [], minConfidence: CONFIDENCE_ANY },
	low: { destinationIds: [], minConfidence: CONFIDENCE_ANY },
})

/**
 * Severity → destination routing for triage outcomes. When AI triage (or a
 * human) sets an issue's severity, matching destinations get notified —
 * detection-time alerts keep using the alert rule's own destinations.
 */
export function EscalationPolicySection({ isAdmin }: { isAdmin: boolean }) {
	const policyQueryAtom = retainedInternalQuery("errors", "getEscalationPolicy", {
		reactivityKeys: ["issueEscalationPolicy"],
	})
	const policyResult = useAtomValue(policyQueryAtom)
	const refreshPolicy = useAtomRefresh(policyQueryAtom)

	const { result: destinationsResult } = useAlertDestinationsList()

	const upsertMutation = useAtomSet(MapleInternalAtomClient.mutation("errors", "upsertEscalationPolicy"), {
		mode: "promiseExit",
	})

	const [enabled, setEnabled] = useState(false)
	const [rules, setRules] = useState<DraftRules>(emptyDraft)
	const [initialized, setInitialized] = useState(false)

	useEffect(() => {
		if (initialized) return
		if (Result.isSuccess(policyResult)) {
			const policy = policyResult.value
			setEnabled(policy.enabled)
			const draft = emptyDraft()
			for (const rule of policy.rules) {
				draft[rule.severity] = {
					destinationIds: [...rule.destinationIds],
					minConfidence: rule.minConfidence ?? CONFIDENCE_ANY,
				}
			}
			setRules(draft)
			setInitialized(true)
		}
	}, [policyResult, initialized])

	const [save, isSaving] = useAsyncAction(async () => {
		const ruleList = SEVERITY_ORDER.filter((severity) => rules[severity].destinationIds.length > 0).map(
			(severity) => {
				const minConfidence = rules[severity].minConfidence
				return new IssueEscalationPolicyRule({
					severity,
					destinationIds: decodeDestinationIds(rules[severity].destinationIds),
					...(minConfidence !== CONFIDENCE_ANY ? { minConfidence } : undefined),
				})
			},
		)
		const result = await upsertMutation({
			payload: new IssueEscalationPolicyUpsertRequest({ enabled, rules: ruleList }),
			reactivityKeys: ["issueEscalationPolicy"],
		})
		toastExit(result, { success: "Escalation policy saved", error: "Failed to save escalation policy" })
	})

	// Never render the editable form off a failed (or pending) policy load —
	// saving a default draft would silently overwrite the real policy.
	if (!initialized) {
		return (
			<div>
				{Result.builder(policyResult)
					.onError((error) => (
						<ErrorState
							error={error}
							title="Failed to load the escalation policy"
							variant="row"
							onRetry={() => refreshPolicy()}
						/>
					))
					.orElse(() => (
						<Skeleton className="h-40 w-full rounded-md" />
					))}
			</div>
		)
	}

	return (
		<div className="space-y-4">
			<Panel padded className="gap-4">
				<SettingRow
					label="Severity escalation"
					description="Route issues to destinations when AI triage or a teammate sets their severity. Fires once per issue and severity level, upward only."
					control={<Switch checked={enabled} onCheckedChange={setEnabled} disabled={!isAdmin} />}
				/>

				{Result.builder(destinationsResult)
					// Destinations come from the live-synced collection, which only
					// resolves to `initial` (loading) or `success` — never a failure —
					// so there is no error/retry branch to render here.
					.onInitial(() => <Skeleton className="h-24 w-full" />)
					.onSuccess((response) => {
						if (response.destinations.length === 0) {
							return (
								<div className="space-y-3">
									<p className="text-muted-foreground text-sm">
										Escalation sends triaged issues to a destination. Add a Slack, email
										or webhook destination first.
									</p>
									<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
										<Button
											size="sm"
											variant="outline"
											render={<Link to="/alerts" search={{ tab: "settings" }} />}
										>
											Add a destination
										</Button>
										<DocsLink page="destinations" />
									</div>
								</div>
							)
						}
						const destinationOptions = response.destinations.map((d) => ({
							value: d.id,
							icon: (
								<ProviderLogo type={d.type} chatConnector={d.chatConnector} size={24} bare />
							),
							label: (
								<span className="flex items-center gap-2">
									<span className="font-medium">{d.name}</span>
									<span className="text-muted-foreground text-xs">
										{destinationProvider(d).label}
									</span>
								</span>
							),
						})) satisfies SegmentedOption<string>[]
						return (
							<div className="space-y-4">
								{SEVERITY_ORDER.map((severity) => (
									<div key={severity} className="space-y-2 border-t border-border/60 pt-3">
										<div className="flex items-center justify-between gap-3">
											<SeverityBadge severity={severity} />
											<div className="flex items-center gap-2">
												<span className="text-muted-foreground text-2xs">
													Min. AI confidence
												</span>
												<Select
													value={rules[severity].minConfidence}
													disabled={!isAdmin}
													onValueChange={(value) => {
														const minConfidence = CONFIDENCE_CHOICES.find(
															(c) => c === value,
														)
														if (!minConfidence) return
														setRules((current) => ({
															...current,
															[severity]: {
																...current[severity],
																minConfidence,
															},
														}))
													}}
												>
													<SelectTrigger size="sm" className="w-[100px]">
														<SelectValue />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value={CONFIDENCE_ANY}>Any</SelectItem>
														<SelectItem value="low">Low</SelectItem>
														<SelectItem value="medium">Medium</SelectItem>
														<SelectItem value="high">High</SelectItem>
													</SelectContent>
												</Select>
											</div>
										</div>
										<MultiSegmentedSelect<string>
											options={destinationOptions}
											value={rules[severity].destinationIds}
											onChange={(values) =>
												setRules((current) => ({
													...current,
													[severity]: {
														...current[severity],
														destinationIds: values,
													},
												}))
											}
											aria-label={`Destinations for ${severity} severity`}
											size="sm"
										/>
									</div>
								))}
							</div>
						)
					})
					.render()}

				<div className="flex justify-end border-t border-border/60 pt-3">
					<Button size="sm" onClick={save} loading={isSaving} disabled={!isAdmin}>
						Save policy
					</Button>
				</div>
			</Panel>
			{!isAdmin ? (
				<p className="text-muted-foreground text-xs">
					Only org admins can change the escalation policy.
				</p>
			) : null}
		</div>
	)
}
