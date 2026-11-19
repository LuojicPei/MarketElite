# MarketElite VPS 公网部署指南（Cloudflare + Caddy 自动 HTTPS）

## 1. 服务器前置要求
- Ubuntu 22.04 / 24.04 VPS（建议 2C4G 起步，开放 `80` / `443` 端口）
- 已安装 Docker & Docker Compose Plugin
- 一个绑定到 Cloudflare DNS 的域名（例如 `marketelite.yourdomain.com`，A 记录指向 VPS 公网 IP）

## 2. 环境变量准备
在服务器克隆仓库并生成 `.env`：
```bash
git clone https://github.com/LOGIC-P/MarketElite.git
cd MarketElite
cp .env.example .env
```

编辑 `.env` 追加公网部署变量：
```env
MARKETELITE_DOMAIN=marketelite.yourdomain.com
MARKETELITE_ACME_EMAIL=your_email@example.com
POSTGRES_USER=marketelite
POSTGRES_PASSWORD=请替换为高强度随机密码
```

## 3. 一键启动全栈生产容器
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

查看运行状态与首次数据同步：
```bash
docker compose -f docker-compose.prod.yml ps
docker exec marketelite-prod-worker python -m scripts.sync_once
```

## 4. Cloudflare 安全配置建议
- **SSL/TLS 模式**：Cloudflare 控制面板设为 **Full (strict)**（配合 Caddy 自动申请的 Let's Encrypt 证书）。
- **SSE 流式缓冲注意**：[Caddyfile](file:///d:/MarketElite/infra/caddy/Caddyfile) 中已为 `/api/*` 开启 `flush_interval -1`，确保后续 Phase 3 LangGraph 流式对话与风控 HITL 实时推流不被反向代理缓冲阻塞。
- **Phoenix 观测台**：[docker-compose.prod.yml](file:///d:/MarketElite/docker-compose.prod.yml) 将 Phoenix UI (`6007`) 默认绑定在 `127.0.0.1`，公网排查时可通过 SSH 端口转发 `ssh -L 6007:127.0.0.1:6007 root@vps-ip` 安全访问。
