output "load_balancer_dns_name" {
  value = aws_lb.this.dns_name
}

output "web_task_role_arn" {
  value = aws_iam_role.web.arn
}

output "worker_task_role_arn" {
  value = aws_iam_role.worker.arn
}

output "migrate_task_definition_arn" {
  value = aws_ecs_task_definition.migrate.arn
}

output "secret_names" {
  description = "Which secrets each process receives. For the tests in reference/tests."
  value       = { for svc, list in local.to_secrets : svc => [for x in list : x.name] }
}

output "deletion_log_encrypted" {
  value = aws_efs_file_system.deletion_log.encrypted
}
