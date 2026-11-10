import { AsyncData } from "foldkit"

/** A loaded value, refreshing included; a failure, a stale value or an empty slot reads as not there yet. */
export const successOf = <A, E>(data: AsyncData.AsyncData<A, E>): A | null =>
	AsyncData.isSuccess(data) || AsyncData.isRefreshing(data) ? data.data : null
