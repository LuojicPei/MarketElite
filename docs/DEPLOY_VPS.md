# MarketElite 公网生产与作品集演示站部署指南（v1.0）

> 适用定位：**作品集 + 公开只读体验站（Positioning A）** —— 访客可直接在线查看实时数据底座、DataOps 血缘、4-Track 评测成绩、免 Key 红蓝压测与沙盒复盘；同时通过只读守卫与 BYOK 机制严防服务端 API 额度被恶意刷爆。

---

## 1. 服务器前置要求
- Ubuntu 22.04 / 24.04 VPS（建议 2C4G 起步，开放 `80` / `443` 端口）
- 已安装 Docker & Docker Compose Plugin
- 已解析至服务器公网 IP 的域名（推荐配合 Cloudflare DNS 启用代理与 SSL）

---

## 2. 克隆代码与安全配置 `.env`

> **密钥安全原则**：GitHub 仓库不含任何真实密钥；请仅在部署服务器本地创建并保护 `.env`。

```bash
git clone https://github.com/LuojicPei/MarketElite.git
cd MarketElite
cp .env.example .env
```

编辑服务器本地 `.env` 时，重点关注以下 **4 组关键参数**：

```env
# 1. 公网域名与数据库强密码
MARKETELITE_DOMAIN=marketelite.yourdomain.com
MARKETELITE_ACME_EMAIL=your_email@example.com
POSTGRES_USER=marketelite
POSTGRES_PASSWORD=请替换为高强度随机密码

# 2. 基础行情 Key（仅用于后台定期更新数据库，不直接暴露给访客）
ALPACA_API_KEY=你的_Alpaca_Key
ALPACA_SECRET_KEY=你的_Alpaca_Secret
FRED_API_KEY=你的_FRED_Key
FINNHUB_API_KEY=你的_Finnhub_Key
SEC_EDGAR_USER_AGENT=MarketElite your_email@example.com

# 3. 保护作者大模型钱包（强制访客自带 BYOK Key）
ALLOW_SERVER_LLM_FALLBACK=false

# 4. 定位 A：开启公网作品集只读守卫，防止陌生人触发 Eval / 管道 / 熔断修改
PUBLIC_SHOWCASE_READONLY=true
ADMIN_API_TOKEN=请替换为高强度管理员令牌
```

---

## 3. 启动全栈生产容器与数据初始化

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

### 数据初始化（二选一）：
- **路径 A（已在 `.env` 填好免费行情 Key）**：触发一次全量实时数据同步
```bash
docker exec marketelite-prod-worker python -m scripts.sync_once
```
- **路径 B（尚未申请外部 Key，先用 0-Key 演示快照上线看效果）**：
```bash
docker exec marketelite-prod-api python -m scripts.seed_demo_snapshot
```

*(同时，系统首次无 Key 空库启动时 `startup_market_bars_warmup` 也会自动调用 `ensure_demo_snapshot_seeded` 完成初始化，且**不会覆盖任何已有真实数据**。)*

---

## 4. Cloudflare 与 Caddy 反代安全要点
- **SSL/TLS 模式**：Cloudflare 控制面板选择 **Full (strict)**，配合 [Caddyfile](../infra/caddy/Caddyfile) 自动签发 Let's Encrypt 证书。
- **SSE 实时推流零缓冲**：`Caddyfile` 已针对 `/api/*` 设置 `flush_interval -1`，确保 Investigator 流式调研（SSE）与 HITL 中断响应实时返回不卡顿。
- **Arize Phoenix 私网隔离**：[docker-compose.prod.yml](../docker-compose.prod.yml) 将 Phoenix UI (`6007`) 默认绑定至 `127.0.0.1`，管理员运维排查时可通过 SSH 隧道安全查看：
```bash
ssh -L 6007:127.0.0.1:6007 root@你的VPS_IP
```
- **解锁中台运维按钮**：当作者本人访问公开网站「数据与评测中台」需要在线重跑 4-Track Eval 或触发增量管道时，只需在页面管理员令牌输入框中传入 `.env` 里的 `ADMIN_API_TOKEN` 即可解锁。
