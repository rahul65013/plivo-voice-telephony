#!/bin/bash
# scripts/launch-ec2.sh
#
# Creates the EC2 instance and security group via AWS CLI.
# Run this from your LOCAL machine (needs AWS CLI installed + configured).
#
# Prerequisites:
#   brew install awscli   (Mac) or
#   pip install awscli    (Linux/Windows)
#   aws configure         (enter your Access Key ID + Secret)

set -e

# ── CONFIG ─────────────────────────────────────────────────────────────────────
AWS_REGION="ap-south-1"          # Mumbai — lowest latency for India
KEY_PAIR_NAME="plivo-server-key" # Name for the new EC2 key pair
INSTANCE_TYPE="t3.small"         # 2 vCPU, 2GB RAM — enough for ~50 concurrent calls
# Ubuntu 22.04 LTS AMI for ap-south-1 (Mumbai) — update for other regions:
#   ap-southeast-1 (Singapore): ami-0df7a207adb9748c7
#   us-east-1 (N. Virginia):    ami-0261755bbcb8c4a84
AMI_ID="ami-0f58b397bc5c1f2e8"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Launching EC2 for Plivo + Sarvam AI Server     ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. Create Key Pair ────────────────────────────────────────────────────────
echo "▶ Step 1/4: Creating EC2 key pair '${KEY_PAIR_NAME}'..."

aws ec2 create-key-pair \
  --key-name $KEY_PAIR_NAME \
  --query "KeyMaterial" \
  --output text \
  --region $AWS_REGION > ~/.ssh/${KEY_PAIR_NAME}.pem

chmod 400 ~/.ssh/${KEY_PAIR_NAME}.pem
echo "   Key saved to: ~/.ssh/${KEY_PAIR_NAME}.pem ✅"

# ── 2. Create Security Group ──────────────────────────────────────────────────
echo "▶ Step 2/4: Creating Security Group..."

SG_ID=$(aws ec2 create-security-group \
  --group-name "plivo-server-sg" \
  --description "Plivo WebSocket server — allow HTTP, HTTPS, SSH" \
  --query "GroupId" \
  --output text \
  --region $AWS_REGION)

echo "   Security Group ID: ${SG_ID}"

# SSH — only from your IP (more secure than 0.0.0.0/0)
MY_IP=$(curl -s https://api.ipify.org)
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp --port 22 --cidr ${MY_IP}/32 \
  --region $AWS_REGION
echo "   SSH (port 22) allowed from your IP: ${MY_IP}"

# HTTP — needed for certbot SSL challenge and redirect to HTTPS
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp --port 80 --cidr 0.0.0.0/0 \
  --region $AWS_REGION
echo "   HTTP (port 80) open to internet"

# HTTPS — Plivo connects here for /answer webhook AND wss:// stream
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp --port 443 --cidr 0.0.0.0/0 \
  --region $AWS_REGION
echo "   HTTPS (port 443) open to internet"

# Note: Port 8080 (Node.js) is NOT opened externally — Nginx proxies to it internally

echo "   Security Group configured ✅"

# ── 3. Launch EC2 Instance ────────────────────────────────────────────────────
echo "▶ Step 3/4: Launching EC2 instance..."

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type $INSTANCE_TYPE \
  --key-name $KEY_PAIR_NAME \
  --security-group-ids $SG_ID \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=plivo-sarvam-server}]' \
  --region $AWS_REGION \
  --query "Instances[0].InstanceId" \
  --output text)

echo "   Instance ID: ${INSTANCE_ID}"

# ── 4. Wait for public IP ──────────────────────────────────────────────────────
echo "▶ Step 4/4: Waiting for instance to be running..."
aws ec2 wait instance-running --instance-ids $INSTANCE_ID --region $AWS_REGION

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --query "Reservations[0].Instances[0].PublicIpAddress" \
  --output text \
  --region $AWS_REGION)

PUBLIC_DNS=$(aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --query "Reservations[0].Instances[0].PublicDnsName" \
  --output text \
  --region $AWS_REGION)

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅ EC2 Instance Ready!                                  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Instance ID  : ${INSTANCE_ID}"
echo "  Public IP    : ${PUBLIC_IP}"
echo "  Public DNS   : ${PUBLIC_DNS}"
echo "  Key pair     : ~/.ssh/${KEY_PAIR_NAME}.pem"
echo ""
echo "  ── Next Steps ──────────────────────────────────────────"
echo ""
echo "  1. Point your domain's A record to: ${PUBLIC_IP}"
echo "     (in Route 53, Cloudflare, GoDaddy — wherever your DNS is)"
echo ""
echo "  2. Wait 1-2 min for the instance to fully boot, then SSH in:"
echo "     ssh -i ~/.ssh/${KEY_PAIR_NAME}.pem ubuntu@${PUBLIC_IP}"
echo ""
echo "  3. On the EC2 instance, upload your code and run setup:"
echo ""
echo "     # From your LOCAL machine — upload the project:"
echo "     rsync -avz -e 'ssh -i ~/.ssh/${KEY_PAIR_NAME}.pem' \\"
echo "       --exclude node_modules --exclude .git \\"
echo "       ./ ubuntu@${PUBLIC_IP}:/home/ubuntu/plivo-server/"
echo ""
echo "     # Then SSH in and run setup:"
echo "     ssh -i ~/.ssh/${KEY_PAIR_NAME}.pem ubuntu@${PUBLIC_IP}"
echo "     cd /home/ubuntu/plivo-server"
echo "     chmod +x scripts/setup-ec2.sh"
echo "     # Edit DOMAIN in scripts/setup-ec2.sh first, then:"
echo "     ./scripts/setup-ec2.sh"
echo ""
echo "  4. Configure Plivo (after setup completes):"
echo "     Answer URL:  https://YOUR_DOMAIN/answer  (Method: GET)"
echo "     Hangup URL:  https://YOUR_DOMAIN/hangup  (Method: POST)"
echo ""
echo "  5. Test a call:"
echo "     curl -X POST https://YOUR_DOMAIN/make-call \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"toNumber\": \"+91XXXXXXXXXX\"}'"
