import { useState } from "react"
import { Exit } from "effect"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import {
	type EscalationConfidence,
	EscalationPolicyEvaluationRequest,
	type IssueSeverity,
} from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Badge } from "@maple/ui/components/ui/badge"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import { ListRow } from "@maple/ui/components/ui/list-row"
import { NativeSelect, NativeSelectOption } from "@maple/ui/components/ui/native-select"

import { SeverityBadge } from "@/components/errors/severity-badge"
import { ErrorState } from "@/components/common/error-state"
import { SkeletonList } from "@maple/ui/components/ui/skeleton"
import { SeveritySelect } from "@/components/errors/severity-select"
import { AiTriageSettingsSection } from "./ai-triage-settings-section"
import { EscalationPolicySection } from "./escalation-policy-section"
import { SettingsSection, SettingsSections } from "@/components/settings/settings-section"
import { MapleInternalAtomClient, retainedInternalQuery } from "@/lib/services/common/internal-atom-client"
import { useAlertDestinationsList } from "@/hooks/use-alerts-list"
import { RelativeTime } from "@/components/common/relative-time"
import { useAsyncAction } from "@/hooks/use-mutation-action"
import { toastExit } from "@/lib/error-toast"

const CONFIDENCES: ReadonlyArray<EscalationConfidence> = ["high", "medium", "low"]

export function AutomationSection({
	isAdmin,
	hasEntitlement,
}: {
	isAdmin: boolean
	hasEntitlement: boolean
}) {
	return (
		<SettingsSections>
			<SettingsSection title="Automatic investigations" framed={false}>
				<AiTriageSettingsSection isAdmin={isAdmin} hasEntitlement={hasEntitlement} />
			</SettingsSection>
			<SettingsSection
				title="Severity and confidence routing"
				description="Confidence gates apply only to AI decisions. A manual severity change is explicit human intent and bypasses the confidence threshold."
				framed={false}
			>
				<EscalationPolicySection isAdmin={isAdmin} />
			</SettingsSection>
			<PolicySimulator />
			<RecentDeliveries />
		</SettingsSections>
	)
}

function PolicySimulator() {
	const [severity, setSeverity] = useState<IssueSeverity>("high")
	const [source, setSource] = useState<"ai" | "manual">("ai")
	const [confidence, setConfidence] = useState<EscalationConfidence>("high")
	const [decision, setDecision] = useState<{
		outcome: "route" | "skip"
		destinationIds: ReadonlyArray<string>
		skipReason: string | null
	} | null>(null)
	const evaluate = useAtomSet(MapleInternalAtomClient.mutation("errors", "evaluateEscalationPolicy"), {
		mode: "promiseExit",
	})
	const { result: destinationsResult } = useAlertDestinationsList()
	const destinations = Result.builder(destinationsResult)
		.onSuccess((response) => response.destinations)
		.orElse(() => [])

	const [run, busy] = useAsyncAction(async () => {
		setDecision(null)
		const result = await evaluate({
			payload: new EscalationPolicyEvaluationRequest({
				severity,
				source,
				...(source === "ai" ? { confidence } : undefined),
			}),
		})
		if (toastExit(result, { error: "Policy evaluation failed" }) && Exit.isSuccess(result)) {
			setDecision(result.value)
		}
	})

	return (
		<SettingsSection title="Policy simulator">
			<div className="grid gap-4 md:grid-cols-3">
				<Field>
					<FieldLabel>Severity</FieldLabel>
					<SeveritySelect
						value={severity}
						onChange={(next) => setSeverity(next ?? "high")}
						className="h-8 w-full"
					/>
				</Field>
				<Field>
					<FieldLabel>Decision source</FieldLabel>
					<NativeSelect
						value={source}
						onChange={(event) => setSource(event.target.value === "manual" ? "manual" : "ai")}
						className="w-full"
					>
						<NativeSelectOption value="ai">AI diagnosis</NativeSelectOption>
						<NativeSelectOption value="manual">Manual change</NativeSelectOption>
					</NativeSelect>
				</Field>
				<Field>
					<FieldLabel>AI confidence</FieldLabel>
					<NativeSelect
						value={confidence}
						onChange={(event) =>
							setConfidence(CONFIDENCES.find((value) => value === event.target.value) ?? "high")
						}
						disabled={source === "manual"}
						className="w-full"
					>
						{CONFIDENCES.map((value) => (
							<NativeSelectOption key={value} value={value}>
								{value}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			</div>
			<div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4">
				<Button size="sm" onClick={() => void run()} loading={busy}>
					Evaluate policy
				</Button>
				{decision ? (
					<>
						<Badge variant="outline" className="capitalize">
							{decision.outcome}
						</Badge>
						<span className="text-sm text-muted-foreground">
							{decision.outcome === "route"
								? decision.destinationIds
										.map(
											(id) =>
												destinations.find((destination) => destination.id === id)
													?.name ?? id,
										)
										.join(", ")
								: decision.skipReason?.replaceAll("_", " ")}
						</span>
					</>
				) : (
					<span className="text-sm text-muted-foreground">
						Preview the exact worker decision without sending a notification.
					</span>
				)}
			</div>
		</SettingsSection>
	)
}

function RecentDeliveries() {
	const result = useAtomValue(
		retainedInternalQuery("errors", "listRecentEscalations", {
			query: { limit: 20 },
			reactivityKeys: ["issueEscalations"],
		}),
	)
	return (
		<SettingsSection title="Recent escalation deliveries" padded={false}>
			{Result.builder(result)
				.onSuccess((response) =>
					response.attempts.length === 0 ? (
						<EmptyMessage>No escalation attempts have been recorded.</EmptyMessage>
					) : (
						<div>
							{response.attempts.map((attempt) => (
								<ListRow
									key={attempt.id}
									divided
									leading={
										<span className="flex w-32 items-center gap-2">
											<SeverityBadge severity={attempt.severity} />
											<span className="capitalize">{attempt.status}</span>
										</span>
									}
									title={
										<span className="font-normal text-muted-foreground">
											{attempt.deliveries.length > 0
												? attempt.deliveries
														.map(
															(delivery) =>
																`${delivery.destinationName ?? delivery.destinationId}: ${delivery.status}`,
														)
														.join(", ")
												: (attempt.skipReason?.replaceAll("_", " ") ??
													"Awaiting delivery")}
										</span>
									}
									trailing={
										<RelativeTime
											value={attempt.createdAt}
											className="text-xs text-muted-foreground"
										/>
									}
								/>
							))}
						</div>
					),
				)
				.onError((error) => (
					<ErrorState
						error={error}
						title="Recent escalation activity could not be loaded"
						variant="inline"
						className="px-4"
					/>
				))
				.orElse(() => (
					<SkeletonList rows={3} rowClassName="h-10" gap="2" className="p-4" />
				))}
		</SettingsSection>
	)
}
