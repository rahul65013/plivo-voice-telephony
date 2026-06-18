#!/bin/bash
# scripts/setup-ec2.sh
#
# Run this ONCE on a fresh AWS EC2 Ubuntu 22.04 instance.
# It installs Node.js, PM2, Nginx, Certbot, and deploys your app.
#
# Usage:
#   chmod +x scripts/setup-ec2.sh
#   ./scripts/setup-ec2.sh
#
# Before running:
#   1. SSH into your EC2 instance
#   2. Upload your project files (see deploy.sh for how)
#   3. Fill in YOUR_DOMAIN and your .env file

set -e  # Exit on any error

DOMAIN="YOUR_DOMAIN_HERE"           # e.g. calls.yourdomain.com
APP_DIR="/home/ubuntu/plivo-server"
LOG_DIR="/var/log/plivo-server"
NODE_VERSION="20"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  EC2 Production Setup — Plivo + Sarvam AI       ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. System update ──────────────────────────────────────────────────────────
echo "▶ Step 1/9: Updating system packages..."
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y curl git unzip nginx certbot python3-certbot-nginx

# ── 2. Install Node.js 20 via NodeSource ──────────────────────────────────────
echo "▶ Step 2/9: Installing Node.js ${NODE_VERSION}..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
sudo apt-get install -y nodejs
echo "   Node version: $(node --version)"
echo "   NPM version:  $(npm --version)"

# ── 3. Install PM2 globally ───────────────────────────────────────────────────
echo "▶ Step 3/9: Installing PM2..."
sudo npm install -g pm2
pm2 --version

# ── 4. Create log directory ───────────────────────────────────────────────────
echo "▶ Step 4/9: Creating log directory..."
sudo mkdir -p $LOG_DIR
sudo chown ubuntu:ubuntu $LOG_DIR

# ── 5. Install app dependencies ───────────────────────────────────────────────
echo "▶ Step 5/9: Installing Node.js dependencies..."
cd $APP_DIR
npm install --omit=dev

# ── 6. Configure Nginx ────────────────────────────────────────────────────────
echo "▶ Step 6/9: Configuring Nginx..."

# Replace YOUR_DOMAIN_HERE in the nginx config with the actual domain
sed "s/YOUR_DOMAIN_HERE/${DOMAIN}/g" $APP_DIR/infra/nginx.conf > /tmp/plivo-server.conf
sudo cp /tmp/plivo-server.conf /etc/nginx/sites-available/plivo-server

# Enable the site and disable the default
sudo ln -sf /etc/nginx/sites-available/plivo-server /etc/nginx/sites-enabled/plivo-server
sudo rm -f /etc/nginx/sites-enabled/default

# Test config is valid
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl start nginx
echo "   Nginx running ✅"

# ── 7. Get SSL certificate from Let's Encrypt ─────────────────────────────────
echo "▶ Step 7/9: Getting SSL certificate for ${DOMAIN}..."
echo "   (Make sure your domain DNS is pointing to this EC2's public IP first!)"
echo "   EC2 Public IP: $(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)"
echo ""
read -p "   Press ENTER once DNS is set, or Ctrl+C to skip SSL and do it later..."

sudo certbot --nginx \
  -d $DOMAIN \
  --non-interactive \
  --agree-tos \
  --email admin@${DOMAIN} \
  --redirect

echo "   SSL certificate installed ✅"

# Certbot auto-renew is already set up by the certbot package
# Verify: sudo systemctl status certbot.timer

# ── 8. Start app with PM2 ─────────────────────────────────────────────────────
echo "▶ Step 8/9: Starting application with PM2..."
cd $APP_DIR

# Create .env from .env.example if it doesn't exist yet
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "   ⚠️  .env file created from .env.example"
  echo "   Edit it now with your real credentials:"
  echo "   nano $APP_DIR/.env"
  echo ""
  read -p "   Press ENTER after filling in your .env file..."
fi

# Start with PM2 in production mode
NODE_ENV=production pm2 start ecosystem.config.js --env production

# Save PM2 process list so it auto-starts after reboot
pm2 save

# Set PM2 to start on system boot
pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -1 | sudo bash
echo "   PM2 running ✅"

# ── 9. Reload Nginx with final SSL config ─────────────────────────────────────
echo "▶ Step 9/9: Final Nginx reload..."
sudo systemctl reload nginx

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ Setup complete!                              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "  App status:     pm2 status"
echo "  App logs:       pm2 logs plivo-server"
echo "  Nginx status:   sudo systemctl status nginx"
echo "  Health check:   curl https://${DOMAIN}/health"
echo ""
echo "  Now configure Plivo:"
echo "  Answer URL:  https://${DOMAIN}/answer  (GET)"
echo "  Hangup URL:  https://${DOMAIN}/hangup  (POST)"
echo ""
echo "  Trigger a test call:"
echo "  curl -X POST https://${DOMAIN}/make-call \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"toNumber\": \"+91XXXXXXXXXX\"}'"
