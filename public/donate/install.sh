#!/bin/bash
# 捐赠节点一键部署脚本
# 用法: bash <(curl -sL https://vip.vip.sd/donate/install.sh) <ws_url> <token>

set -e

WS_URL="$1"
TOKEN="$2"

if [ -z "$WS_URL" ] || [ -z "$TOKEN" ]; then
  echo "❌ 缺少参数"
  echo "用法: bash install.sh <ws_url> <token>"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ 请以 root 身份运行"
  exit 1
fi

echo "🍑 小姨子的诱惑 - 捐赠节点部署"
echo "=================================="

# 检测系统
if command -v apt-get &>/dev/null; then
  PKG="apt-get"
elif command -v yum &>/dev/null; then
  PKG="yum"
else
  echo "❌ 不支持的系统，需要 Debian/Ubuntu/CentOS"
  exit 1
fi

# 安装 Xray
echo "📦 安装 Xray..."
if ! command -v xray &>/dev/null; then
  bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
fi
echo "✅ Xray 已安装: $(xray version | head -1)"

# 安装 Node.js
echo "📦 检查 Node.js..."
if ! command -v node &>/dev/null; then
  echo "安装 Node.js..."
  if [ "$PKG" = "apt-get" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  fi
fi
echo "✅ Node.js: $(node -v)"

# 下载 Agent
echo "📦 部署 Agent..."
mkdir -p /opt/vless-agent /etc/vless-agent

# 从面板下载 agent.js
PANEL_URL=$(echo "$WS_URL" | sed 's|wss://|https://|;s|ws://|http://|;s|/ws/agent||')
curl -sL "${PANEL_URL}/donate/agent.js" -o /opt/vless-agent/agent.js
chmod 755 /opt/vless-agent/agent.js

# 写配置（标记为捐赠节点）
cat > /etc/vless-agent/config.json << EOF
{
  "server": "${WS_URL}",
  "token": "${TOKEN}",
  "nodeId": 0,
  "isDonation": true
}
EOF
chmod 600 /etc/vless-agent/config.json

# 创建 systemd 服务
NODE_BIN=$(which node)
cat > /etc/systemd/system/vless-agent.service << EOF
[Unit]
Description=VLESS Panel Agent
After=network.target

[Service]
Type=simple
ExecStart=${NODE_BIN} /opt/vless-agent/agent.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable vless-agent
systemctl restart vless-agent

echo ""
echo "=================================="
echo "✅ 部署完成！"
echo "Agent 已启动并连接到平台"
echo "管理员审核通过后节点将自动上线"
echo "感谢你的捐赠！🍑"
echo "=================================="
