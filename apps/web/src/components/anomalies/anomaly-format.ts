import type { AnomalySignalType } from "@maple/domain/http"
import { BoltIcon, ChartLineIcon, CircleWarningIcon, FileIcon, PulseIcon } from "@/components/icons"

// The React-free formatting lives in `@maple/web-data/anomalies/format` (shared with the Foldkit app).
export {
	anomalyAffectsServiceHealth,
	deviation,
	formatSignalValue,
	isStaleOpenIncident,
	META_CHIP_CLASS,
	RESOLVE_REASON_LABEL,
	SEVERITY_TONE,
	severityToneFor,
	SIGNAL_LABEL,
	TRIAGE_STATUS_CHIP,
} from "@maple/web-data/anomalies/format"

export const SIGNAL_ICON: Record<AnomalySignalType, typeof PulseIcon> = {
	error_rate: CircleWarningIcon,
	latency_p95: ChartLineIcon,
	throughput: PulseIcon,
	error_spike: BoltIcon,
	log_volume: FileIcon,
} satisfies Record<AnomalySignalType, typeof PulseIcon>
