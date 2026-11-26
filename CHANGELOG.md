# Changelog

All notable releases and engineering milestones of **MarketElite** are documented in this file.

## [1.0.0] - 2026-11-27

First production-complete open-source release (**1 Deterministic Market Cockpit + 3 Closed-Loop Agents + DataOps & 4-Track Eval Governance Platform**).

### Added & Shipped
- **Five Flagship Workstations**:
  1. **市场总览 (Market Overview Cockpit)**: Macro Regime & Net Liquidity (`WALCL - WTREGEN - RRPONTSYD`), VIX term structure (`9D/Spot/3M`), HY/IG credit spreads, Market Breadth, 11-sector rotation heatmap, Estimated GEX (`Call Wall / Put Wall / Zero Gamma`), 6+6+12 Microstructure modules (FINRA ATS dark pool, Institutional Flow, CFTC COT, On-Chain Crypto Pulse, Top Movers), and bilingual live news discovery.
  2. **我的关注 (My Watchlist & Asset Inspector)**: Drag-and-drop multi-tenant watchlist (`X-Workspace-Id`), per-stock candlestick + intraday structure charts, live consensus EPS & catalysts, and instant AI copilot launcher.
  3. **投研与风控台 (Multi-Agent Copilot & Risk Critic)**:
     - **Investigator**: LangGraph multi-step agent with 8 read-only FastMCP tools (`Streamable HTTP`), lazy SEC 10-K/10-Q/8-K Hybrid RAG (`pgvector + tsvector` RRF), 40 categorized rotating Chinese prompt chips (`10s` cadence), and collapsible multi-turn thread archive.
     - **Bull vs Bear CRO Debate Arena**: Manual-launch adversarial debate (Zero auto-LLM waste on tab switch), plain-Chinese `key_insights`, and 7-tile Key Levels matrix.
     - **Risk Critic & HITL Gate**: Deterministic 1% max-loss position sizing, ATR / Options Wall bracket ladder preview, and PostgreSQL-persisted `AsyncPostgresSaver` `interrupt()` pause/resume approval flow.
  4. **模拟盘与复盘 (Multi-Broker Portfolio, Watchdog & Evolution Lab)**:
     - Unified adapter supporting **6 account modes**: 24/7 Local Sandbox (`$100k`), Alpaca Paper, Interactive Brokers Flex (Read-Only), Binance Spot (Read-Only), Trading212 (`Live/Demo` Read-Only), and Universal CSV Import (Robinhood/Futu/Schwab).
     - Non-blocking SWR progressive loader + 45s Redis broker state cache.
     - 24/7 Watchdog Autopilot Sentinel, Net Equity vs SPY curve, 2x2 Discipline × Outcome scatter matrix, AI Portfolio Post-Mortem Coach, and pinnable Playbook Iron Rules.
  5. **数据与评测中台 (DataOps & 4-Track Eval Governance Platform)**:
     - Real-time 16-table 4-layer warehouse lineage graph (`ODS → DWD → DWS → ADS`), Redis hot-cache telemetry & circuit breakers, 6 automated Data Quality (DQ) health checks, RAG & Episodic Memory corpus governance, FinOps cost tracking, and **4-Track Full-Stack Evals (54 cases)**: `Golden Benchmark (32)`, `Agent Sandbox (6)`, `RAG Faithfulness (8)`, `Red-Team Safety (8)`.
- **Open-Source Cold-Start & Security Architecture**:
  - Zero-Key Static Demo Snapshot (`backend/scripts/seed_demo_snapshot.py` + automatic empty-DB startup fallback) — zero secrets shipped, ready to run out of the box without any external keys.
  - Positioning A public showcase hardening (`PUBLIC_SHOWCASE_READONLY`, `ADMIN_API_TOKEN`, `ALLOW_SERVER_LLM_FALLBACK=false`) + browser-local BYOK credential transport.
- **3-Theme Liquid Glass UI Engine**: Light Glass, Warm Sand Paper, and Obsidian Dark themes with Zero-Border Aurora interactive cards.
