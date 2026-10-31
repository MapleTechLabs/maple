/** Share of the limit as a percentage, or null when Railway reported no limit. */
export const shareOfLimit = (value: number, limit: number) => (limit > 0 ? (value / limit) * 100 : null)
