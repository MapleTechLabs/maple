import type { DashboardRefreshIntervalSeconds } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"

import { ArrowUpIcon, MediaPauseIcon } from "@/components/icons"
import { RefreshControls } from "@/components/time-range-picker/refresh-controls"
import { usePageRefreshContext } from "@/components/time-range-picker/page-refresh-context"

import type { LogsInspectState } from "./logs-table"

interface LogsLiveControlsProps {
	value: DashboardRefreshIntervalSeconds
	onChange: (value: DashboardRefreshIntervalSeconds) => void
	inspect: LogsInspectState
	onJumpToLatest: () => void
}

/**
 * The logs header's reload split button, plus why the tail is holding still.
 * The note sits left of the control so its coming and going never moves the
 * time picker or the button under the cursor.
 */
export function LogsLiveControls({ value, onChange, inspect, onJumpToLatest }: LogsLiveControlsProps) {
	const { isReloading, reload } = usePageRefreshContext()
	const paused = value > 0 && inspect.inspecting

	return (
		<div className="flex items-center gap-2">
			<output className="flex items-center gap-2">
				{paused && (
					<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
						<MediaPauseIcon size={10} />
						Paused while you inspect
					</span>
				)}
				{paused && inspect.scrolledAway && (
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onClick={() => {
							onJumpToLatest()
							reload()
						}}
					>
						<ArrowUpIcon size={12} />
						Jump to latest
					</Button>
				)}
			</output>
			<RefreshControls onReload={reload} isReloading={isReloading} value={value} onChange={onChange} />
		</div>
	)
}
