import { ListHostsResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { InfraHostsSearch } from "../../../../route/search"
import * as Frame from "../../../kit/time-frame"
import * as InstallModal from "../../kit/install-modal"
import { SortState } from "../../../kit/table-sort"

export const HostRows = ListHostsResponse.fields.data
export type HostRow = ListHostsResponse["data"][number]

export const Model = Schema.Struct({
	search: InfraHostsSearch,
	frame: Frame.Model,
	hosts: KeyedSchema(HostRows, LoadFailure),
	/** Initial key `cpuPct`, descending. */
	sort: SortState,
	install: InstallModal.Model,
})
export type Model = typeof Model.Type
