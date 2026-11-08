# One reference deployment: never applied, see infra/environments/production/README.md.
provider "aws" {
  region = var.region
  default_tags {
    tags = { Application = var.name, ManagedBy = "opentofu" }
  }
}

module "network" {
  source              = "../modules/network"
  name                = var.name
  vpc_cidr            = var.vpc_cidr
  availability_zones  = var.availability_zones
  ingress_cidrs       = var.ingress_cidrs
  worker_egress_ports = var.worker_egress_ports
}

module "kms" {
  source         = "../modules/kms"
  name           = var.name
  region         = var.region
  key_admin_arns = var.key_admin_arns
  app_role_arns  = [module.compute.web_task_role_arn, module.compute.worker_task_role_arn]
}

module "database" {
  source                = "../modules/database"
  name                  = var.name
  engine_version        = var.postgres_engine_version
  instance_class        = var.db_instance_class
  allocated_storage_gb  = var.db_allocated_storage_gb
  backup_retention_days = var.backup_retention_days
  log_retention_days    = var.log_retention_days
  subnet_ids            = module.network.data_subnet_ids
  security_group_id     = module.network.database_security_group_id
  kms_key_arn           = module.kms.infrastructure_key_arn
}

module "secrets" {
  source           = "../modules/secrets"
  name             = var.name
  kms_key_arn      = module.kms.infrastructure_key_arn
  optional_secrets = var.optional_secrets
}

module "compute" {
  source                   = "../modules/compute"
  name                     = var.name
  region                   = var.region
  vpc_id                   = module.network.vpc_id
  public_subnet_ids        = module.network.public_subnet_ids
  web_subnet_ids           = module.network.web_subnet_ids
  worker_subnet_ids        = module.network.worker_subnet_ids
  services_subnet_ids      = module.network.services_subnet_ids
  alb_security_group_id    = module.network.alb_security_group_id
  web_security_group_id    = module.network.web_security_group_id
  worker_security_group_id = module.network.worker_security_group_id
  clamd_security_group_id  = module.network.clamd_security_group_id
  certificate_arn          = var.certificate_arn
  app_origin               = var.app_origin
  web_image                = var.web_image
  worker_image             = var.worker_image
  clamd_image              = var.clamd_image
  web_desired_count        = var.web_desired_count
  worker_desired_count     = var.worker_desired_count
  log_retention_days       = var.log_retention_days
  infrastructure_key_arn   = module.kms.infrastructure_key_arn
  app_key_arn              = module.kms.app_key_arn
  extra_environment        = var.extra_environment
  secret_arns              = module.secrets.secret_arns
}
