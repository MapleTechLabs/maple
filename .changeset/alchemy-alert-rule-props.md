---
"@maple-dev/alchemy": minor
---

`AlertRuleProps` is discriminated, so a rule that combines fields the API rejects fails to type-check instead of failing the deploy. By scope: `group_by` and `exclude_service_names` only without `service_names`, and `exclude_service_names` only with `group_by: ["service.name"]`. By `signal_type`: `builder_query` requires `query_builder_draft` and takes no `service_names` or `exclude_service_names`; `raw_query` requires `raw_query_sql`, takes `raw_query_reducer`, and takes no `service_names`, `group_by` or `exclude_service_names`; every other signal takes none of those query fields. By `comparator`: `between` and `not_between` require `threshold_upper`, which no other comparator takes. A grouped rule takes no `alert_on_no_data: true`. A grouped `builder_query` rule takes none either.

Updates now send `service_names`, `exclude_service_names`, `group_by` and `alert_on_no_data` on every deploy, an undeclared one as its default (`[]`, `[]`, `null`, `false`). Removing one from props clears it instead of keeping the old value next to its replacement.

Breaking: `AlertRuleProps` is a union, so an `interface` can no longer extend it, and `signal_type` and `comparator` must be literals.
