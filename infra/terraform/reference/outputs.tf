output "load_balancer_dns_name" {
  description = "Point the app's DNS record here."
  value       = module.compute.load_balancer_dns_name
}

output "database_endpoint" {
  description = "Host for the connection strings in Secrets Manager."
  value       = module.database.endpoint
}

output "database_master_secret_arn" {
  description = "RDS-managed master credential. Used once, to create the migration login."
  value       = module.database.master_secret_arn
}

output "secret_arns" {
  description = "Set these values out of band. This configuration never holds them."
  value       = module.secrets.secret_arns
}

output "app_key_arn" {
  description = "Root key for a KmsProvider. Not usable until that provider exists."
  value       = module.kms.app_key_arn
}

output "migrate_task_definition" {
  description = "Run this once per release, before updating the services."
  value       = module.compute.migrate_task_definition_arn
}
