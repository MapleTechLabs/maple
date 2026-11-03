/**
 * The API tab's bucket size: the rollups are minute- and hour-grain, so a sub-hour
 * bucket rounds to whole minutes and an hour or more to whole hours, which the
 * hourly tier tiles exactly. The web asks with it and the API enforces it, so a
 * per-bucket rate is always divided by the size the query ran with.
 */
export const alignServiceApiBucketSeconds = (bucketSeconds: number): number =>
	bucketSeconds >= 3600
		? Math.round(bucketSeconds / 3600) * 3600
		: Math.max(60, Math.round(bucketSeconds / 60) * 60)
