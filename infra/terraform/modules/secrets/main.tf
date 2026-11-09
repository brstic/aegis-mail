locals {
  # Names only. A value set here would land in state. Set them after the first apply: an ECS task can't start while a
  # secret it names has no value, so only what this deployment uses is created.
  required = {
    DATABASE_URL        = "Migration-only login. Only the migration task gets this."
    DATABASE_URL_WEB    = "Web process login, a member of aegis_web_conn"
    DATABASE_URL_WORKER = "Worker process login, a member of aegis_worker_conn"
  }
  optional = {
    GOOGLE_CLIENT_SECRET    = "Google OAuth client"
    MICROSOFT_CLIENT_SECRET = "Microsoft OAuth client"
    OPENAI_API_KEY          = "Hosted AI"
    ANTHROPIC_API_KEY       = "Hosted AI, alternative provider"
  }
  secrets = merge(local.required, { for k, v in local.optional : k => v if contains(var.optional_secrets, k) })
}

resource "aws_secretsmanager_secret" "this" {
  for_each                = local.secrets
  name                    = "${var.name}/${each.key}"
  description             = each.value
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = 30
}
