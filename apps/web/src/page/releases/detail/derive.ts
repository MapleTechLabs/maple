import { groupReleases, type ReleaseGroup } from "../../../components/releases/release-model"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { deriveOf } from "../list/derive"
import type { Model } from "./model"

/** The deploy this page describes, once the releases of the window have loaded. */
export const groupOf = (model: Model): Option.Option<ReleaseGroup> =>
	Option.flatMap(AsyncData.getData(model.releases.data), (data) =>
		Arr.findFirst(groupReleases(deriveOf(data).impacts), (group) => group.commitSha === model.commitSha),
	)
