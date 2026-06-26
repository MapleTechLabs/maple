import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"

import { deriveHostStatus, formatPercent, formatRelative, severityLevel } from "./format"
import {
	HoneycombSection,
	type HoneycombCell,
	type HoneycombLegendItem,
	type HoneycombTone,
} from "./honeycomb"
import { EntityPreviewDrawer } from "./honeycomb-preview-drawer"
import { StatRail, StatRailItem } from "./primitives/stat-rail"
import { HeroChip } from "./primitives/page-hero"
import { HostStatusBadge } from "./status-badge"
import type { PodRow } from "./pod-table"

interface PodHoneycombProps {
	pods: ReadonlyArray<PodRow>
	referenceTime?: string
}

function toneOf(pod: PodRow, referenceTime?: string): HoneycombTone {
	if (deriveHostStatus(pod.lastSeen, referenceTime) !== "active") return "stale"
	return severityLevel(Math.max(pod.cpuLimitPct ?? 0, pod.memoryLimitPct ?? 0))
}

function workloadOf(pod: PodRow): string | null {
	if (pod.deploymentName) return `deploy ${pod.deploymentName}`
	if (pod.statefulsetName) return `sts ${pod.statefulsetName}`
	if (pod.daemonsetName) return `ds ${pod.daemonsetName}`
	return null
}

function toCell(pod: PodRow, referenceTime: string | undefined, onSelect: () => void): HoneycombCell {
	const tone = toneOf(pod, referenceTime)
	const worst = Math.max(pod.cpuLimitPct ?? 0, pod.memoryLimitPct ?? 0)
	return {
		key: `${pod.namespace}/${pod.podName}`,
		glyph: pod.podName.charAt(0).toUpperCase() || "·",
		tone,
		ariaLabel: `${pod.podName} — worst limit ${formatPercent(worst)}`,
		onSelect,
		tooltip: (
			<>
				<div className="font-mono font-medium">{pod.podName}</div>
				<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono tabular-nums">
					<span className="text-muted-foreground">CPU req</span>
					<span>{formatPercent(pod.cpuRequestPct)}</span>
					<span className="text-muted-foreground">CPU limit</span>
					<span>{formatPercent(pod.cpuLimitPct)}</span>
					<span className="text-muted-foreground">Mem req</span>
					<span>{formatPercent(pod.memoryRequestPct)}</span>
					<span className="text-muted-foreground">Mem limit</span>
					<span>{formatPercent(pod.memoryLimitPct)}</span>
				</div>
				<div className="border-t pt-1 text-[10px] text-muted-foreground">
					{pod.namespace ? `ns ${pod.namespace}` : "no namespace"}
					{pod.nodeName ? ` · node ${pod.nodeName}` : ""} · {formatRelative(pod.lastSeen)}
				</div>
			</>
		),
	}
}

export function PodHoneycomb({ pods, referenceTime }: PodHoneycombProps) {
	const [selected, setSelected] = useState<PodRow | null>(null)

	const cells = useMemo(
		() => pods.map((p) => toCell(p, referenceTime, () => setSelected(p))),
		[pods, referenceTime],
	)

	const legend = useMemo<HoneycombLegendItem[]>(() => {
		const c: Record<HoneycombTone, number> = { ok: 0, warn: 0, crit: 0, stale: 0 }
		for (const p of pods) c[toneOf(p, referenceTime)]++
		return [
			{ tone: "ok", label: "Healthy", count: c.ok },
			{ tone: "warn", label: "Elevated", count: c.warn },
			{ tone: "crit", label: "Saturated", count: c.crit },
			{ tone: "stale", label: "Stale", count: c.stale },
		]
	}, [pods, referenceTime])

	const workload = selected ? workloadOf(selected) : null

	return (
		<>
			<HoneycombSection
				label="Pods"
				count={pods.length}
				unit="pod"
				cells={cells}
				legend={legend}
				footnote="cell = max(cpu limit, memory limit)"
			/>
			{selected && (
				<EntityPreviewDrawer
					open
					onOpenChange={(open) => !open && setSelected(null)}
					title={selected.podName}
					status={<HostStatusBadge lastSeen={selected.lastSeen} referenceTime={referenceTime} />}
					stats={
						<StatRail columns={4}>
							<StatRailItem
								eyebrow="CPU limit"
								value={formatPercent(selected.cpuLimitPct)}
								tone={severityLevel(selected.cpuLimitPct ?? 0)}
								compact
							/>
							<StatRailItem
								eyebrow="CPU req"
								value={formatPercent(selected.cpuRequestPct)}
								tone={severityLevel(selected.cpuRequestPct ?? 0)}
								compact
							/>
							<StatRailItem
								eyebrow="Mem limit"
								value={formatPercent(selected.memoryLimitPct)}
								tone={severityLevel(selected.memoryLimitPct ?? 0)}
								compact
							/>
							<StatRailItem
								eyebrow="Mem req"
								value={formatPercent(selected.memoryRequestPct)}
								tone={severityLevel(selected.memoryRequestPct ?? 0)}
								compact
							/>
						</StatRail>
					}
					meta={
						<>
							{selected.namespace && <HeroChip>ns {selected.namespace}</HeroChip>}
							{selected.nodeName && <HeroChip>node {selected.nodeName}</HeroChip>}
							{selected.qosClass && <HeroChip>qos {selected.qosClass}</HeroChip>}
							{workload && <HeroChip>{workload}</HeroChip>}
						</>
					}
					detailLink={
						<Link
							to="/infra/kubernetes/pods/$podName"
							params={{ podName: selected.podName }}
							search={selected.namespace ? { namespace: selected.namespace } : {}}
						/>
					}
				/>
			)}
		</>
	)
}
