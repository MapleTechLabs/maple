export const formatCores = (value: number) =>
	`${value.toLocaleString(undefined, { maximumFractionDigits: value < 1 ? 3 : 2 })} vCPU`

/** Share of the limit as a percentage, or null when Railway reported no limit. */
export const shareOfLimit = (value: number, limit: number) => (limit > 0 ? (value / limit) * 100 : null)
