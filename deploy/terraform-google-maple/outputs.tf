output "push_service_account_email" {
  description = "The identity Pub/Sub signs pushes to Maple as. Null while log forwarding is off."
  value       = one(google_service_account.push[*].email)
}

output "reader_service_account_email" {
  description = "The read-only account Maple reads metrics and resources as. Null without maple_service_account."
  value       = one(google_service_account.reader[*].email)
}

output "sink_writer_identity" {
  description = "The Google-managed identity the log sink writes as. Null while log forwarding is off."
  value       = local.writer_identity
}
