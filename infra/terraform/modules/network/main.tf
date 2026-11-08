locals {
  # One /24 per tier per zone. Tiers are separate subnets because a network ACL only acts at a subnet boundary, and the
  # workers' deny rules below have to stand between workers and everything else in the VPC.
  tiers = { public = 0, web = 10, worker = 20, services = 30, data = 40 }
  subnets = {
    for pair in setproduct(keys(local.tiers), range(length(var.availability_zones))) :
    "${pair[0]}-${pair[1]}" => {
      tier = pair[0]
      az   = var.availability_zones[pair[1]]
      cidr = cidrsubnet(var.vpc_cidr, 8, local.tiers[pair[0]] + pair[1])
    }
  }
  # Workers must not reach these, except the database and clamd allowed by name below. 100.64/10 is shared address space
  # used inside some VPCs. 169.254/16 is listed for the record: see the note on metadata in the production README.
  denied_ranges  = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"]
  data_cidrs     = [for k, s in local.subnets : s.cidr if s.tier == "data"]
  services_cidrs = [for k, s in local.subnets : s.cidr if s.tier == "services"]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

# Nothing may use the default security group.
resource "aws_default_security_group" "locked" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "this" {
  for_each                = local.subnets
  vpc_id                  = aws_vpc.this.id
  cidr_block              = each.value.cidr
  availability_zone       = each.value.az
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-${each.key}", Tier = each.value.tier }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_eip" "nat" {
  domain = "vpc"
}

# One gateway keeps the reference cheap. A zone outage stops worker egress, which sync survives by retrying.
resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.this["public-0"].id
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }
}

# No default route: the database tier has no way out at all.
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id
}

resource "aws_route_table_association" "this" {
  for_each  = local.subnets
  subnet_id = aws_subnet.this[each.key].id
  route_table_id = (
    each.value.tier == "public" ? aws_route_table.public.id :
    each.value.tier == "data" ? aws_route_table.data.id :
    aws_route_table.private.id
  )
}

# Security groups only allow, so they can't subtract private ranges from 0.0.0.0/0. This ACL does the subtracting.
# It's stateless, so the ingress side has to admit return traffic.
resource "aws_network_acl" "worker" {
  vpc_id     = aws_vpc.this.id
  subnet_ids = [for k, s in aws_subnet.this : s.id if local.subnets[k].tier == "worker"]
  tags       = { Name = "${var.name}-worker" }

  ingress {
    rule_no    = 100
    protocol   = "tcp"
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 1024
    to_port    = 65535
  }

  dynamic "egress" {
    for_each = local.data_cidrs
    content {
      rule_no    = 100 + egress.key
      protocol   = "tcp"
      action     = "allow"
      cidr_block = egress.value
      from_port  = 5432
      to_port    = 5432
    }
  }

  dynamic "egress" {
    for_each = local.services_cidrs
    content {
      rule_no    = 120 + egress.key
      protocol   = "tcp"
      action     = "allow"
      cidr_block = egress.value
      from_port  = 3310
      to_port    = 3310
    }
  }

  dynamic "egress" {
    for_each = local.denied_ranges
    content {
      rule_no    = 200 + egress.key
      protocol   = "-1"
      action     = "deny"
      cidr_block = egress.value
      from_port  = 0
      to_port    = 0
    }
  }

  dynamic "egress" {
    for_each = var.worker_egress_ports
    content {
      rule_no    = 300 + egress.key
      protocol   = "tcp"
      action     = "allow"
      cidr_block = "0.0.0.0/0"
      from_port  = egress.value
      to_port    = egress.value
    }
  }
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "Load balancer"
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = toset(var.ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each          = toset(var.ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, which only redirects to HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Web tasks"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.web.id
}

resource "aws_security_group" "web" {
  name_prefix = "${var.name}-web-"
  description = "Web tasks"
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  description                  = "Load balancer"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "web_to_db" {
  security_group_id            = aws_security_group.web.id
  description                  = "Database"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.database.id
}

resource "aws_vpc_security_group_egress_rule" "web_https" {
  security_group_id = aws_security_group.web.id
  description       = "KMS, Secrets Manager, registry, OAuth token endpoints"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "worker" {
  name_prefix = "${var.name}-worker-"
  description = "Workers. No ingress. Egress is an allowlist, narrowed further by the subnet's network ACL."
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "worker_allowlist" {
  for_each          = toset([for p in var.worker_egress_ports : tostring(p)])
  security_group_id = aws_security_group.worker.id
  description       = "Mail and provider APIs"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_db" {
  security_group_id            = aws_security_group.worker.id
  description                  = "Database"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.database.id
}

resource "aws_vpc_security_group_egress_rule" "worker_to_clamd" {
  security_group_id            = aws_security_group.worker.id
  description                  = "clamd"
  ip_protocol                  = "tcp"
  from_port                    = 3310
  to_port                      = 3310
  referenced_security_group_id = aws_security_group.clamd.id
}

resource "aws_security_group" "clamd" {
  name_prefix = "${var.name}-clamd-"
  description = "clamd, reachable only from workers"
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "clamd_from_worker" {
  security_group_id            = aws_security_group.clamd.id
  description                  = "Workers"
  ip_protocol                  = "tcp"
  from_port                    = 3310
  to_port                      = 3310
  referenced_security_group_id = aws_security_group.worker.id
}

resource "aws_vpc_security_group_egress_rule" "clamd_https" {
  security_group_id = aws_security_group.clamd.id
  description       = "freshclam signature downloads and the registry"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "database" {
  name_prefix = "${var.name}-db-"
  description = "PostgreSQL. No egress rules."
  vpc_id      = aws_vpc.this.id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_web" {
  security_group_id            = aws_security_group.database.id
  description                  = "Web"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.web.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_worker" {
  security_group_id            = aws_security_group.database.id
  description                  = "Workers and the migration task"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.worker.id
}
