import { AsyncData } from "foldkit"

/** An optional page input: a failed load reads as empty, so it neither holds the page back nor fails it. */
export const emptyOnFailure = <A, E>(
	data: AsyncData.AsyncData<ReadonlyArray<A>, E>,
): AsyncData.AsyncData<ReadonlyArray<A>, never> =>
	AsyncData.isFailure(data)
		? AsyncData.Success({ data: [] })
		: AsyncData.isStale(data)
			? AsyncData.Success({ data: data.data })
			: data
