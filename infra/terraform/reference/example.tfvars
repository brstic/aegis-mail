# Placeholders. Validation needs nothing more, and `tofu plan` needs real AWS credentials as well.
region             = "eu-west-1"
availability_zones = ["eu-west-1a", "eu-west-1b"]
app_origin         = "https://mail.example.com"
certificate_arn    = "arn:aws:acm:eu-west-1:111122223333:certificate/00000000-0000-0000-0000-000000000000"
key_admin_arns     = ["arn:aws:iam::111122223333:role/deployer"]
web_image          = "111122223333.dkr.ecr.eu-west-1.amazonaws.com/aegis:web-0000000"
worker_image       = "111122223333.dkr.ecr.eu-west-1.amazonaws.com/aegis:worker-0000000"
clamd_image        = "111122223333.dkr.ecr.eu-west-1.amazonaws.com/aegis:clamd-0000000"
