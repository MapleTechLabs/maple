import { ListHostsResponse } from "@maple/domain/http"
import { Schema } from "effect"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { InfraHostsSearch } from "../../../../route/search"
import * as Frame from "../../kit/frame"
import * as InstallModal from "../../kit/install-modal"
import { SortState } from "../../kit/sort"

// `/infra/hosts` (apps/web/src/routes/infra/hosts/index.tsx).

export const HostRows = ListHostsResponse.fields.data
export type HostRow = ListHostsResponse["data"][number]

export const Model = Schema.Struct({
	search: InfraHostsSearch,
	frame: Frame.Model,
	hosts: KeyedSchema(HostRows, LoadFailure),
	/** `useTableSort` in `HostTable`: initial key `cpuPct`, descending. */
	sort: SortState,
	install: InstallModal.Model,
})
export type Model = typeof Model.Type
