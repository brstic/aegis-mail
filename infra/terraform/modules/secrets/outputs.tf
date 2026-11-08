output "secret_arns" {
  description = "By environment variable name."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}
