variable "connector_id" {
  description = "The connection's ID in Maple. Every resource name is derived from it."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.connector_id))
    error_message = "connector_id is the UUID Maple shows for the connection."
  }
}

variable "scope_type" {
  description = "What the connection covers: \"project\", \"folder\" or \"organization\"."
  type        = string

  validation {
    condition     = contains(["project", "folder", "organization"], var.scope_type)
    error_message = "scope_type is \"project\", \"folder\" or \"organization\"."
  }
}

variable "scope_id" {
  description = "The project ID, or the numeric folder or organization ID."
  type        = string
}

variable "project_id" {
  description = "The host project: it holds the Pub/Sub topic, the subscription and both service accounts. For a project scope, the project itself."
  type        = string
}

variable "push_endpoint" {
  description = "Maple's receiver for this connection. It carries no secret: Pub/Sub signs each push as the push service account, and Maple accepts only that account's tokens."
  type        = string

  validation {
    condition     = can(regex("^https://[^?#]+/v1/logpush/gcp/[0-9a-f-]{36}$", var.push_endpoint))
    error_message = "push_endpoint is the https URL Maple shows for the connection, without a query string."
  }
}

variable "maple_service_account" {
  description = "Maple's own service account, allowed to read as the read-only account. Null leaves read-only access out: live metric queries and key metrics then can't read this scope."
  type        = string
  default     = null
}

variable "logs_enabled" {
  description = "Forward logs to Maple through a Log Router sink and a Pub/Sub push subscription."
  type        = bool
  default     = true
}

variable "log_filter" {
  description = "The sink's inclusion filter. Maple's generated configuration fills it in; see https://maple.dev/docs/integrations/gcp#which-logs-are-forwarded."
  type        = string
}

variable "enable_apis" {
  description = "Switch on the APIs the resources need in the host project. Set false where APIs are managed elsewhere. They are never switched off on destroy."
  type        = bool
  default     = true
}
