---
"@maple-dev/alchemy": minor
---

`Maple.Dashboard` props are typed by the API's dashboard schemas, and the package exports them (`DashboardData`, `DashboardWidget`, `DashboardSection`, `DashboardVariable`, `DashboardTimeRange`) so panels and dashboards can be shared as values. `refresh_interval_seconds` is now managed. `dashboardId` adopts an existing dashboard by its ID: a missing ID fails the deploy instead of creating a new dashboard.
