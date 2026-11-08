output "app_key_arn" {
  value = aws_kms_key.app.arn
}

output "infrastructure_key_arn" {
  value = aws_kms_key.infrastructure.arn
}

output "app_policy" {
  description = "For the tests in reference/tests."
  value       = local.app_policy
}
