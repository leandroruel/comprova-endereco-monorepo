resource "aws_kms_key" "evidence" {
  count                   = var.create_storage ? 1 : 0
  description             = "comprova evidence encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_s3_bucket" "evidence" {
  count  = var.create_storage ? 1 : 0
  bucket = "comprova-evidence-${var.environment}"
}

resource "aws_s3_bucket_lifecycle_configuration" "evidence" {
  count  = var.create_storage ? 1 : 0
  bucket = aws_s3_bucket.evidence[0].id

  rule {
    id     = "archive-old-evidence"
    status = "Enabled"

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = var.evidence_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  count  = var.create_storage ? 1 : 0
  bucket = aws_s3_bucket.evidence[0].id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.evidence[0].arn
      sse_algorithm     = "aws:kms"
    }
  }
}

variable "create_storage" {
  type    = bool
  default = false
}

variable "evidence_retention_days" {
  type    = number
  default = 365
}
