output "endpoint" {
  value = aws_db_instance.this.address
}

output "master_secret_arn" {
  value = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "parameters" {
  description = "For the tests in reference/tests."
  value       = aws_db_parameter_group.this.parameter
}

output "publicly_accessible" {
  value = aws_db_instance.this.publicly_accessible
}

output "storage_encrypted" {
  value = aws_db_instance.this.storage_encrypted
}

output "deletion_protection" {
  value = aws_db_instance.this.deletion_protection
}

output "backup_retention_period" {
  value = aws_db_instance.this.backup_retention_period
}

output "skip_final_snapshot" {
  value = aws_db_instance.this.skip_final_snapshot
}
