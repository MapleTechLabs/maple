import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Exit } from "effect"
import { toast } from "sonner"

import { Schema } from "effect"

import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	IssueEscalationPolicyRule,
	IssueEscalationPolicyUpsertRequest,
	type AlertDestinationDocument,
	type EscalationConfidence,
	type IssueSeverity,
} from "@maple/domain/http"
import { AlertDestinationId } from "@maple/domain/primitives"

const decodeDestinationIds = Schema.decodeUnknownSync(Schema.Array(AlertDestinationId))

import { Button } from "@maple/ui/components/ui/button"
import { Card } from "@maple/ui/components/ui/card"
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@maple/ui/components/ui/select"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"

import {
	AlertMultiSegmentedSelect,
	type AlertSegmentedOption,
} from "@/components/alerts/alert-segmented-select"
import { ProviderLogo } from "@/components/alerts/destination-provider"
import { SeverityBadge, SEVERITY_ORDER } from "@/components/errors/severity-badge"
import { destinationTypeLabels } from "@/lib/alerts/form-utils"

const CONFIDENCE_ANY = "any" as const

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
	const policyQueryAtom = MapleApiAtomClient.query("errors", "getEscalationPolicy", {
		reactivityKeys: ["issueEscalationPolicy"],
	})
	const policyResult = useAtomValue(policyQueryAtom)
	const refreshPolicy = useAtomRefresh(policyQueryAtom)

	const destinationsResult = useAtomValue(MapleApiAtomClient.query("alerts", "listDestinations", {}))
	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => [...response.destinations] as AlertDestinationDocument[])
		.orElse(() => [] as AlertDestinationDocument[])

	const upsertMutation = useAtomSet(MapleApiAtomClient.mutation("errors", "upsertEscalationPolicy"), {
		mode: "promiseExit",
	})

	const [enabled, setEnabled] = useState(false)
	const [rules, setRules] = useState<DraftRules>(emptyDraft)
	const [initialized, setInitialized] = useState(false)
	const [isSaving, setIsSaving] = useState(false)

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
		} else if (!Result.isInitial(policyResult)) {
			setInitialized(true)
		}
	}, [policyResult, initialized])

	const save = async () => {
		setIsSaving(true)
		const ruleList = SEVERITY_ORDER.filter(
			(severity) => rules[severity].destinationIds.length > 0,
		).map(
			(severity) =>
				new IssueEscalationPolicyRule({
					severity,
					destinationIds: decodeDestinationIds(rules[severity].destinationIds),
					...(rules[severity].minConfidence === CONFIDENCE_ANY
						? {}
						: { minConfidence: rules[severity].minConfidence as EscalationConfidence }),
				}),
		)
		const result = await upsertMutation({
			payload: new IssueEscalationPolicyUpsertRequest({ enabled, rules: ruleList }),
			reactivityKeys: ["issueEscalationPolicy"],
		})
		setIsSaving(false)
		if (Exit.isSuccess(result)) {
			refreshPolicy()
			toast.success("Escalation policy saved")
		} else {
			toast.error("Failed to save escalation policy")
		}
	}

	if (!initialized) {
		return (
			<div className="max-w-2xl">
				<Skeleton className="h-40 w-full rounded-lg" />
			</div>
		)
	}

	const destinationOptions = destinations.map((d) => ({
		value: d.id as unknown as string,
		icon: <ProviderLogo type={d.type} size={24} bare />,
		label: (
			<span className="flex items-center gap-2">
				<span className="font-medium">{d.name}</span>
				<span className="text-muted-foreground text-xs">{destinationTypeLabels[d.type]}</span>
			</span>
		),
	})) satisfies AlertSegmentedOption<string>[]

	return (
		<div className="max-w-2xl space-y-4">
			<Card className="space-y-4 p-4">
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="text-sm font-medium">Severity escalation</p>
						<p className="text-muted-foreground text-xs">
							Route issues to destinations when AI triage or a teammate sets their severity.
							Fires once per issue and severity level, upward only.
						</p>
					</div>
					<Switch checked={enabled} onCheckedChange={setEnabled} disabled={!isAdmin} />
				</div>

				{destinations.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No destinations yet.{" "}
						<Link
							to="/alerts"
							search={{ tab: "settings" }}
							className="underline underline-offset-4 hover:text-foreground"
						>
							Create one in Alerts settings
						</Link>{" "}
						first.
					</p>
				) : (
					<div className="space-y-4">
						{SEVERITY_ORDER.map((severity) => (
							<div key={severity} className="space-y-2 border-t border-border/60 pt-3">
								<div className="flex items-center justify-between gap-3">
									<SeverityBadge severity={severity} />
									<div className="flex items-center gap-2">
										<span className="text-muted-foreground text-[11px]">
											Min. AI confidence
										</span>
										<Select
											value={rules[severity].minConfidence}
											disabled={!isAdmin}
											onValueChange={(value) =>
												setRules((current) => ({
													...current,
													[severity]: {
														...current[severity],
														minConfidence:
															value as SeverityRuleDraft["minConfidence"],
													},
												}))
											}
										>
											<SelectTrigger size="sm" className="h-7 w-[100px] text-xs">
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
								<AlertMultiSegmentedSelect<string>
									options={destinationOptions}
									value={rules[severity].destinationIds}
									onChange={(values) =>
										setRules((current) => ({
											...current,
											[severity]: { ...current[severity], destinationIds: values },
										}))
									}
									aria-label={`Destinations for ${severity} severity`}
									size="sm"
								/>
							</div>
						))}
					</div>
				)}

				<div className="flex justify-end border-t border-border/60 pt-3">
					<Button size="sm" onClick={save} disabled={!isAdmin || isSaving}>
						{isSaving ? "Saving…" : "Save policy"}
					</Button>
				</div>
			</Card>
			{!isAdmin ? (
				<p className="text-muted-foreground text-xs">
					Only org admins can change the escalation policy.
				</p>
			) : null}
		</div>
	)
}
