data "aws_caller_identity" "current" {}

locals {
  admin_actions = [
    "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*",
    "kms:Get*", "kms:Delete*", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
    "kms:RotateKeyOnDemand",
  ]
}

# Wraps tenant keys. Administrators can manage it but not use it, and the app can use it but not manage it. There's no
# statement for the account root, so an IAM policy alone can never grant Decrypt.
locals {
  app_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Administer"
        Effect    = "Allow"
        Principal = { AWS = var.key_admin_arns }
        Action    = local.admin_actions
        Resource  = "*"
      },
      {
        # A provider must bind each wrap to its context (KmsProvider.wrap's second argument) as encryption context.
        Sid       = "AppWrapAndUnwrapWithContext"
        Effect    = "Allow"
        Principal = { AWS = var.app_role_arns }
        Action    = ["kms:Encrypt", "kms:Decrypt"]
        Resource  = "*"
        Condition = { Null = { "kms:EncryptionContext:aegis" = "false" } }
      },
      {
        Sid       = "AppDescribe"
        Effect    = "Allow"
        Principal = { AWS = var.app_role_arns }
        Action    = ["kms:DescribeKey"]
        Resource  = "*"
      },
    ]
  })
  infrastructure_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Administer"
        Effect    = "Allow"
        Principal = { AWS = var.key_admin_arns }
        Action    = local.admin_actions
        Resource  = "*"
      },
      {
        Sid       = "RdsAndSecretsManagerInThisAccount"
        Effect    = "Allow"
        Principal = { AWS = "*" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:CreateGrant", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:CallerAccount" = data.aws_caller_identity.current.account_id
            "kms:ViaService"    = ["rds.${var.region}.amazonaws.com", "secretsmanager.${var.region}.amazonaws.com"]
          }
        }
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:*" }
        }
      },
    ]
  })
}

resource "aws_kms_key" "app" {
  description             = "${var.name}: wraps tenant keys"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = local.app_policy
}

resource "aws_kms_alias" "app" {
  name          = "alias/${var.name}-app"
  target_key_id = aws_kms_key.app.key_id
}

# Disk, secret and log encryption. Only AWS services use it, on behalf of this account, and it can't touch tenant keys.
resource "aws_kms_key" "infrastructure" {
  description             = "${var.name}: RDS, Secrets Manager, CloudWatch Logs"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = local.infrastructure_policy
}

resource "aws_kms_alias" "infrastructure" {
  name          = "alias/${var.name}-infrastructure"
  target_key_id = aws_kms_key.infrastructure.key_id
}
