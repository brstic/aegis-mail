output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "public"]
}

output "web_subnet_ids" {
  value = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "web"]
}

output "worker_subnet_ids" {
  value = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "worker"]
}

output "services_subnet_ids" {
  value = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "services"]
}

output "data_subnet_ids" {
  value = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "data"]
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "web_security_group_id" {
  value = aws_security_group.web.id
}

output "worker_security_group_id" {
  value = aws_security_group.worker.id
}

output "clamd_security_group_id" {
  value = aws_security_group.clamd.id
}

output "database_security_group_id" {
  value = aws_security_group.database.id
}

output "worker_acl_egress" {
  description = "For the tests in reference/tests."
  value       = aws_network_acl.worker.egress
}
