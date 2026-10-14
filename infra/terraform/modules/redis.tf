resource "aws_elasticache_replication_group" "redis" {
  count                = var.create_redis ? 1 : 0
  replication_group_id = "comprova-redis"
  description          = "comprova cache + rate limit tokens"
  engine               = "redis"
  node_type            = var.node_type
  number_cache_clusters = var.shard_count
  parameter_group_name = "default.redis7"
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  multi_az_enabled     = true
}

variable "create_redis" {
  type    = bool
  default = false
}

variable "node_type" {
  type    = string
  default = "cache.r6g.large"
}

variable "shard_count" {
  type    = number
  default = 1
}
