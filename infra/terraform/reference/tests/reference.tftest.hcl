# Runs the whole configuration against a mocked provider: no AWS account, no credentials, nothing created. It proves the
# module wiring and the security properties of what would be planned. It proves nothing about AWS accepting it.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111122223333" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/mock" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:eu-west-1:111122223333:key/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_db_instance" {
    defaults = { master_user_secret = [{ kms_key_id = "mock", secret_arn = "arn:aws:secretsmanager:eu-west-1:111122223333:secret:rds", secret_status = "active" }] }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-west-1:111122223333:secret:mock" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-1:111122223333:loadbalancer/app/mock/0" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-1:111122223333:targetgroup/mock/0" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:eu-west-1:111122223333:task-definition/mock:1" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:eu-west-1:111122223333:cluster/mock" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:eu-west-1:111122223333:service/srv-mock" }
  }
}

variables {
  region             = "eu-west-1"
  availability_zones = ["eu-west-1a", "eu-west-1b"]
  app_origin         = "https://mail.example.com"
  certificate_arn    = "arn:aws:acm:eu-west-1:111122223333:certificate/00000000-0000-0000-0000-000000000000"
  key_admin_arns     = ["arn:aws:iam::111122223333:role/deployer"]
  web_image          = "registry.example/aegis:web"
  worker_image       = "registry.example/aegis:worker"
  clamd_image        = "registry.example/aegis:clamd"
}

run "database_requires_tls_and_is_private" {
  command = plan
  assert {
    condition     = one([for p in module.database.parameters : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "rds.force_ssl must be on"
  }
  assert {
    condition     = module.database.publicly_accessible == false && module.database.storage_encrypted == true && module.database.deletion_protection == true
    error_message = "The database must be private, encrypted and protected from deletion"
  }
  assert {
    condition     = module.database.backup_retention_period == 14 && module.database.skip_final_snapshot == false
    error_message = "Backups must be on, with a final snapshot"
  }
}

run "older_postgres_is_refused" {
  command = plan
  variables {
    postgres_engine_version = "15"
  }
  expect_failures = [var.postgres_engine_version]
}

run "demo_mode_is_refused" {
  command = plan
  variables {
    extra_environment = { DEMO_MODE = "true" }
  }
  expect_failures = [var.extra_environment]
}

run "worker_egress_denies_private_ranges_before_allowing_anything_public" {
  command = plan
  assert {
    condition = alltrue([for r in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"] :
    contains([for e in module.network.worker_acl_egress : e.cidr_block if e.action == "deny"], r)])
    error_message = "RFC1918 and link-local must be denied"
  }
  assert {
    condition = (
      max([for e in module.network.worker_acl_egress : e.rule_no if e.action == "deny"]...) <
      min([for e in module.network.worker_acl_egress : e.rule_no if e.action == "allow" && e.cidr_block == "0.0.0.0/0"]...)
    )
    error_message = "Every deny must be evaluated before any public allow"
  }
  assert {
    condition = alltrue([for e in module.network.worker_acl_egress :
    e.action == "deny" || contains([143, 443, 465, 587, 993, 995, 5432, 3310], e.from_port)])
    error_message = "Only listed ports may be allowed"
  }
}

run "app_key_policy_is_narrow" {
  command = plan
  assert {
    condition     = !strcontains(module.kms.app_policy, ":root")
    error_message = "No root statement on the app key"
  }
  assert {
    condition = alltrue([for s in jsondecode(module.kms.app_policy).Statement :
    !contains(s.Action, "kms:Decrypt") if s.Sid == "Administer"])
    error_message = "Administrators must not be able to decrypt"
  }
  assert {
    condition = alltrue([for s in jsondecode(module.kms.app_policy).Statement :
    !anytrue([for a in s.Action : a == "kms:*"])])
    error_message = "No wildcard actions"
  }
  assert {
    condition = alltrue([for s in jsondecode(module.kms.app_policy).Statement :
    can(s.Condition.Null["kms:EncryptionContext:aegis"]) if s.Sid == "AppWrapAndUnwrapWithContext"])
    error_message = "Wrapping must require an encryption context"
  }
}

run "processes_only_get_their_own_login" {
  command = plan
  assert {
    condition     = !contains(module.compute.secret_names.web, "DATABASE_URL") && !contains(module.compute.secret_names.web, "DATABASE_URL_WORKER")
    error_message = "Web must not see other logins"
  }
  assert {
    condition     = !contains(module.compute.secret_names.worker, "DATABASE_URL") && !contains(module.compute.secret_names.worker, "DATABASE_URL_WEB")
    error_message = "Workers must not see other logins"
  }
  assert {
    condition     = module.compute.secret_names.migrate == ["DATABASE_URL"]
    error_message = "Migrations only need the migration login"
  }
}

run "worker_has_durable_storage_for_the_deletion_log" {
  command = plan
  assert {
    condition     = module.compute.deletion_log_encrypted
    error_message = "The deletion log's storage must be encrypted"
  }
}
