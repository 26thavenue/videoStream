#!/bin/bash
# scripts/init-buckets.sh
awslocal s3 mb s3://raw-videos
awslocal s3 mb s3://processed-videos
awslocal s3api put-bucket-cors --bucket processed-videos --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"]
  }]
}'