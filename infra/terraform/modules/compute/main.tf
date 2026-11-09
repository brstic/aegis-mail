locals {
  clamd_host = "clamd.${var.name}.internal"
  # Which process may see which secret. A process that isn't given a database login can't use it.
  web_secrets     = ["DATABASE_URL_WEB", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_SECRET"]
  worker_secrets  = ["DATABASE_URL_WORKER", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_SECRET", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
  migrate_secrets = ["DATABASE_URL"]
  log_config = { for svc in ["web", "worker", "clamd", "migrate"] : svc => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.this[svc].name
      awslogs-region        = var.region
      awslogs-stream-prefix = svc
    }
  } }
  # DEMO_MODE is absent on purpose. NODE_ENV=production makes boot refuse a dev KMS and any owner-role fallback.
  common_env = concat([
    { name = "NODE_ENV", value = "production" },
    { name = "APP_ORIGIN", value = var.app_origin },
    { name = "WEBAUTHN_RP_ID", value = trimprefix(var.app_origin, "https://") },
  ], [for k, v in var.extra_environment : { name = k, value = v }])
  to_secrets = { for svc, names in { web = local.web_secrets, worker = local.worker_secrets, migrate = local.migrate_secrets } : svc => [
    for n in names : { name = n, valueFrom = var.secret_arns[n] } if contains(keys(var.secret_arns), n)
  ] }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each          = toset(["web", "worker", "clamd", "migrate"])
  name              = "/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.infrastructure_key_arn
}

data "aws_iam_policy_document" "assume_ecs" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name_prefix        = "${var.name}-exec-"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(var.secret_arns)
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.infrastructure_key_arn]
  }
}

resource "aws_iam_role_policy" "read_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_role" "web" {
  name_prefix        = "${var.name}-web-"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs.json
}

resource "aws_iam_role" "worker" {
  name_prefix        = "${var.name}-worker-"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs.json
}

# Migrations and clamd make no AWS calls, so they get no task role.
data "aws_iam_policy_document" "use_app_key" {
  statement {
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"]
    resources = [var.app_key_arn]
  }
}

resource "aws_iam_role_policy" "web_kms" {
  name   = "use-app-key"
  role   = aws_iam_role.web.id
  policy = data.aws_iam_policy_document.use_app_key.json
}

resource "aws_iam_role_policy" "worker_kms" {
  name   = "use-app-key"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.use_app_key.json
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  subnets                    = var.public_subnet_ids
  security_groups            = [var.alb_security_group_id]
  drop_invalid_header_fields = true
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "web" {
  name_prefix = "web-"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = "/api/v1/health"
    matcher = "200"
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.web.arn
  container_definitions = jsonencode([{
    name             = "web"
    image            = var.web_image
    essential        = true
    portMappings     = [{ containerPort = 3000, protocol = "tcp" }]
    environment      = local.common_env
    secrets          = local.to_secrets.web
    logConfiguration = local.log_config.web
  }])
}

resource "aws_ecs_service" "web" {
  name            = "web"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.web_desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.web_subnet_ids
    security_groups = [var.web_security_group_id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.https]
}

# The deletion log has to outlive the database and the task, and Fargate has no durable disk. It's in this account for simplicity, so an
# account-level compromise reaches both it and the database: AWS Backup to another account is the next step, and isn't configured here.
resource "aws_efs_file_system" "deletion_log" {
  encrypted       = true
  kms_key_id      = var.infrastructure_key_arn
  throughput_mode = "elastic"
  tags            = { Name = "${var.name}-deletion-log" }
  lifecycle { prevent_destroy = true }
}

resource "aws_security_group" "deletion_log" {
  name_prefix = "${var.name}-deletion-log-"
  description = "NFS from workers only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "deletion_log_nfs" {
  security_group_id            = aws_security_group.deletion_log.id
  referenced_security_group_id = var.worker_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
}

resource "aws_vpc_security_group_egress_rule" "worker_to_deletion_log" {
  security_group_id            = var.worker_security_group_id
  referenced_security_group_id = aws_security_group.deletion_log.id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
}

resource "aws_efs_mount_target" "deletion_log" {
  for_each        = { for i, id in var.worker_subnet_ids : tostring(i) => id }
  file_system_id  = aws_efs_file_system.deletion_log.id
  subnet_id       = each.value
  security_groups = [aws_security_group.deletion_log.id]
}

resource "aws_efs_access_point" "deletion_log" {
  file_system_id = aws_efs_file_system.deletion_log.id
  posix_user {
    uid = 1000
    gid = 1000
  }
  root_directory {
    path = "/deletion-log"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0750"
    }
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker.arn
  container_definitions = jsonencode([{
    name      = "worker"
    image     = var.worker_image
    essential = true
    environment = concat(local.common_env, [
      { name = "CLAMD_HOST", value = local.clamd_host },
      { name = "CLAMD_PORT", value = "3310" },
      { name = "AEGIS_DELETION_LOG_PATH", value = "/deletion-log/deletions.jsonl" },
    ])
    mountPoints      = [{ sourceVolume = "deletion-log", containerPath = "/deletion-log", readOnly = false }]
    secrets          = local.to_secrets.worker
    logConfiguration = local.log_config.worker
  }])
  volume {
    name = "deletion-log"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.deletion_log.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.deletion_log.id
        iam             = "DISABLED"
      }
    }
  }
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.worker_subnet_ids
    security_groups = [var.worker_security_group_id]
  }
}

# Run by hand or by the release process, in worker subnets with the worker security group, before services update.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name             = "migrate"
    image            = var.worker_image
    essential        = true
    command          = ["pnpm", "db:migrate"]
    environment      = local.common_env
    secrets          = local.to_secrets.migrate
    logConfiguration = local.log_config.migrate
  }])
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${var.name}.internal"
  vpc  = var.vpc_id
}

resource "aws_service_discovery_service" "clamd" {
  name = "clamd"
  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

resource "aws_ecs_task_definition" "clamd" {
  family                   = "${var.name}-clamd"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  # Signatures alone take about 1.5 GB resident, and double during a reload.
  memory             = 4096
  execution_role_arn = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name             = "clamd"
    image            = var.clamd_image
    essential        = true
    portMappings     = [{ containerPort = 3310, protocol = "tcp" }]
    logConfiguration = local.log_config.clamd
  }])
}

resource "aws_ecs_service" "clamd" {
  name            = "clamd"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.clamd.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.services_subnet_ids
    security_groups = [var.clamd_security_group_id]
  }
  service_registries {
    registry_arn = aws_service_discovery_service.clamd.arn
  }
}
