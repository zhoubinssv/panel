#!/bin/bash
set -euo pipefail

# vless-agent 安装脚本
# 用法: ./install.sh <server_url> <token> <node_id> [--check-ipv6]

if [ $# -lt 3 ]; then
  echo "用法: $0 <server_url> <token> <node_id> [--check-ipv6]"
  echo "示例: $0 wss://vip.vip.sd/ws/agent my-secret-token 123"
  echo "  加 --check-ipv6 开启 IPv6 连通性检测（SS 节点用）"
  exit 1
fi

SERVER_URL="$1"
TOKEN="$2"
NODE_ID="$3"
CHECK_IPV6=false
if [ "${4:-}" = "--check-ipv6" ]; then
  CHECK_IPV6=true
fi
AGENT_DIR="/opt/vless-agent"
CONFIG_DIR="/etc/vless-agent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== vless-agent 安装 ==="
echo "Server: ${SERVER_URL}"
echo "NodeId: ${NODE_ID}"
echo ""

# 检查 Node.js
if ! command -v node &>/dev/null; then
  echo "❌ 未找到 Node.js，请先安装 Node.js 18+"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
echo "Node.js 版本: $(node -v)"

# 创建配置
mkdir -p "$CONFIG_DIR"
cat > "${CONFIG_DIR}/config.json" <<EOF
{
  "server": "${SERVER_URL}",
  "token": "${TOKEN}",
  "nodeId": ${NODE_ID},
  "checkIPv6": ${CHECK_IPV6}
}
EOF
chmod 600 "${CONFIG_DIR}/config.json"
echo "✅ 配置写入 ${CONFIG_DIR}/config.json"

# 复制 agent
mkdir -p "$AGENT_DIR"
cp "${SCRIPT_DIR}/agent.js" "${AGENT_DIR}/agent.js"
chmod 755 "${AGENT_DIR}/agent.js"
echo "✅ agent.js 复制到 ${AGENT_DIR}/"

# 创建 systemd service
cat > /etc/systemd/system/vless-agent.service <<EOF
[Unit]
Description=VLESS Panel Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(which node) ${AGENT_DIR}/agent.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# 安全限制
NoNewPrivileges=no
ProtectSystem=false

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vless-agent

[Install]
WantedBy=multi-user.target
EOF
echo "✅ systemd 服务已创建"

# 启动服务
systemctl daemon-reload
systemctl enable vless-agent
systemctl restart vless-agent
echo "✅ 服务已启动并设为开机自启"

echo ""
echo "=== 安装完成 ==="
echo "查看日志: journalctl -u vless-agent -f"
echo "服务状态: systemctl status vless-agent"
