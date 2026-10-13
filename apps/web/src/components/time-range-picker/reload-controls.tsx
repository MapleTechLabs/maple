import { RefreshButton } from "@maple/ui/components/ui/refresh-button"

import { usePageRefreshContext } from "./page-refresh-context"

export function ReloadControls() {
	const { isReloading, reload } = usePageRefreshContext()

	return <RefreshButton onRefresh={reload} pending={isReloading} label="Reload" />
}
