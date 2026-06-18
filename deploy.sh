#!/bin/bash
# scripts/deploy.sh
#
# Deploys code updates to your EC2 instance.
# Run this from your LOCAL machine every time you update code.
#
# Usage:
#   chmod +x scripts/deploy.sh
#   ./scripts/deploy.sh
#
# Prerequisites:
#   - EC2_HOST set to your EC2 public IP or domain
#   - Your EC2 key pair PEM file
#   - SSH access to ubuntu@EC2_HOST

set -e

# ── CONFIG — fill these in ────────────────────────────────────────────────────
EC2_HOST="YOUR_EC2_PUBLIC_IP_OR_DOMAIN"     # e.g. 13.233.xx.xx or calls.yourdomain.com
EC2_KEY="~/.ssh/your-key-pair.pem"         # path to your EC2 key pair
EC2_USER="ubuntu"
APP_DIR="/home/ubuntu/plivo-server"

echo "▶ Deploying to ${EC2_USER}@${EC2_HOST}..."

# ── 1. Sync source files to EC2 (excludes node_modules, .env, logs) ──────────
echo "   Syncing files..."
rsync -avz --progress \
  --exclude "node_modules/" \
  --exclude ".env" \
  --exclude "*.log" \
  --exclude ".git/" \
  -e "ssh -i ${EC2_KEY} -o StrictHostKeyChecking=no" \
  ./ ${EC2_USER}@${EC2_HOST}:${APP_DIR}/

# ── 2. SSH in and restart the app ─────────────────────────────────────────────
echo "   Restarting app..."
ssh -i ${EC2_KEY} ${EC2_USER}@${EC2_HOST} << 'REMOTE'
  cd /home/ubuntu/plivo-server
  npm install --omit=dev
  NODE_ENV=production pm2 reload ecosystem.config.js --env production
  pm2 save
  echo "   App restarted ✅"
  pm2 status
REMOTE

echo ""
echo "✅ Deployment complete!"
echo "   Check logs: ssh -i ${EC2_KEY} ${EC2_USER}@${EC2_HOST} 'pm2 logs plivo-server --lines 50'"
