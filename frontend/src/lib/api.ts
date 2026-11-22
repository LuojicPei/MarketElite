export interface ComponentHealth {
  status: "up" | "down" | "disabled";
  latency_ms: number;
  detail: string;
  pgvector_enabled?: boolean;
  ui_url?: string;
}

export interface IntegrationReadiness {
  id: string;
  name: string;
  category: string;
  requires_key: boolean;
  configured: boolean;
  mode: string;
}

export interface HealthResponse {
  service: string;
  env: string;
  phase: string;
  status: "ok" | "degraded" | "initializing";
  checked_at: string;
  components: {
    postgres: ComponentHealth;
    redis: ComponentHealth;
    phoenix: ComponentHealth;
  };
  integrations: IntegrationReadiness[];
}

export interface ArchitectureStage {
  id: string;
  order: number;
  tag: string;
  title: string;
  subtitle: string;
  summary: string;
  components: string[];
  phase: string;
}

export interface ArchitectureResponse {
  name: string;
  positioning: string;
  stages: ArchitectureStage[];
}

export interface NetLiquidityPoint {
  date: string;
  walcl_b: number;
  tga_b: number;
  rrp_b: number;
  net_liquidity_b: number;
}

export interface AssetTechnicals {
  available: boolean;
  as_of_date?: string;
  last_close?: number;
  change_1d_pct?: number | null;
  change_5d_pct?: number | null;
  change_20d_pct?: number | null;
  ema_5?: number | null;
  ema_10?: number | null;
  ema_20?: number | null;
  sma_50?: number | null;
  sma_200?: number | null;
  dist_50ma_pct?: number | null;
  dist_200ma_pct?: number | null;
  rsi_14?: number | null;
  macd?: {
    macd: number;
    signal: number;
    histogram: number;
  } | null;
  atr_14?: number | null;
  atr_pct?: number | null;
  rvol_20?: number | null;
  volume_price_tag?: string;
}

export interface StrikeGexProfile {
  strike: number;
  call_gex: number;
  put_gex: number;
  net_gex: number;
  call_oi: number;
  put_oi: number;
}

export interface EstimatedGexSnapshot {
  symbol?: string;
  snapshot_time: string;
  spot_price: number;
  net_gex: number;
  call_wall: number | null;
  put_wall: number | null;
  zero_gamma: number | null;
  put_call_ratio: number | null;
  total_call_oi: number;
  total_put_oi: number;
  contracts_analyzed?: number;
  assumption_label: string;
  strike_profile: StrikeGexProfile[];
  is_stale: boolean;
}

export interface SectorRotationItem {
  symbol: string;
  name: string;
  bucket: "Offensive" | "Cyclical" | "Defensive";
  last_close: number | null;
  return_1d_pct: number | null;
  return_5d_pct: number | null;
  return_20d_pct: number | null;
  rel_spy_20d_pct: number | null;
  rvol_20: number | null;
}

export interface CotContractSummary {
  contract: string;
  report_date: string;
  noncomm_net: number;
  wow_change: number | null;
  noncomm_net_pct_oi: number | null;
  open_interest: number;
}

export interface CalendarEventItem {
  event_key: string;
  event_type: "macro" | "earnings" | string;
  event_time: string;
  symbol: string | null;
  title: string;
  impact: string;
  actual?: number | null;
  estimate: number | null;
  previous: number | null;
  eps_actual?: number | null;
  eps_estimate: number | null;
}

export interface DashboardOverviewResponse {
  status: "ok" | "empty_bootstrap_needed";
  cache_source: "redis" | "postgres_fallback" | "none";
  fetched_at?: string;
  generated_at?: string;
  regime_date?: string;
  message?: string;
  provider_states?: Record<string, string>;
  regime?: {
    regime_label: string;
    stress_score: number;
    support_score: number;
    drivers: string[];
    fear_greed: {
      score: number | null;
      label: string;
      components: Record<string, number | null>;
    };
  };
  macro?: {
    net_liquidity: {
      series: NetLiquidityPoint[];
      latest_billions: number | null;
      latest_date: string | null;
      delta_5d_billions: number | null;
      delta_20d_billions: number | null;
    };
    yield_credit: {
      dgs2: number | null;
      dgs10: number | null;
      dfii10: number | null;
      yield_spread_10y2y: number | null;
      hy_oas: number | null;
      ig_oas: number | null;
      sofr: number | null;
      wresbal_billions: number | null;
      hyg_lqd_ratio: number | null;
      hyg_lqd_20d_delta_pct: number | null;
      credit_state: string;
    };
    vix_structure: {
      vix9d: number | null;
      vix: number | null;
      vix3m: number | null;
      vix_vix3m_ratio: number | null;
      vix9d_vix_ratio: number | null;
      structure_state: string;
    };
  };
  equities?: {
    core_indices: Record<string, AssetTechnicals>;
    breadth: {
      universe_tracked_50ma: number;
      universe_tracked_200ma: number;
      pct_above_50ma: number | null;
      pct_above_200ma: number | null;
      advances: number;
      declines: number;
      adv_dec_ratio: number | null;
      rsp_spy_ratio: number | null;
      rsp_spy_20d_delta_pct: number | null;
    };
    sector_rotation: SectorRotationItem[];
    cross_asset_correlations: Record<
      string,
      { corr_20d?: number | null; corr_60d?: number | null }
    >;
  };
  options_gex?: Record<string, EstimatedGexSnapshot>;
  positioning_and_calendar?: {
    cot: Record<string, CotContractSummary>;
    upcoming_events: CalendarEventItem[];
  };
}

export interface DailyBarPoint {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number | null;
}

export interface AssetNewsItem {
  id: string;
  headline: string;
  source: string;
  url: string;
  symbols: string[];
  created_at: string;
}

export interface EpsHistoryPoint {
  period: string;
  estimate: number | null;
  actual: number | null;
  surprise_percent: number | null;
  source: string;
}

export interface AnalystRecommendationPoint {
  symbol: string;
  period: string;
  strong_buy: number;
  buy: number;
  hold: number;
  sell: number;
  strong_sell: number;
}

export interface RegimeHistoryPoint {
  regime_date: string;
  regime_label: string;
  fear_greed_score: number | null;
  fear_greed_label: string | null;
  vix_spot: number | null;
  vix_3m: number | null;
  vix_term_ratio: number | null;
  rsp_spy_ratio: number | null;
  pct_above_50ma: number | null;
  hy_oas: number | null;
  net_liquidity_bn: number | null;
}

export interface AssetProfile {
  symbol: string;
  name: string;
  exchange: string;
  industry?: string | null;
  logo_url?: string | null;
  weburl?: string | null;
  ipo?: string | null;
  market_cap_b?: number | null;
}

export interface AssetMetrics {
  open: number;
  day_high: number;
  day_low: number;
  prev_close: number;
  volume: number;
  avg_vol_10d: number | null;
  week52_high: number | null;
  week52_low: number | null;
  pe_ttm: number | null;
  pb: number | null;
  beta: number | null;
  dividend_yield: number | null;
  change_1d_abs: number;
  change_5d_pct: number | null;
  change_1m_pct: number | null;
  change_6m_pct: number | null;
  change_ytd_pct: number | null;
  bars_count: number;
}

export interface AssetDetailResponse {
  symbol: string;
  asset_class: string;
  source: string;
  bars: DailyBarPoint[];
  technicals: AssetTechnicals;
  profile?: AssetProfile;
  metrics?: AssetMetrics;
  options_gex: EstimatedGexSnapshot | null;
  news: AssetNewsItem[];
  eps_history?: EpsHistoryPoint[];
  recommendations?: AnalystRecommendationPoint[];
}

export interface WatchlistAssetItem {
  symbol: string;
  name: string;
  exchange: string;
  industry?: string | null;
  asset_class: string;
  trade_date: string;
  price: number;
  prev_close: number;
  change_1d_abs: number;
  change_1d_pct: number | null;
  change_5d_pct: number | null;
  change_1m_pct: number | null;
  change_6m_pct: number | null;
  change_ytd_pct: number | null;
  rsi_14: number | null;
  rvol_20: number | null;
  market_cap_b: number | null;
  pe_ttm: number | null;
  sparkline_bars: MacroTapeBar[];
  daily_closes: { d: string; c: number }[];
}

export interface WatchlistResponse {
  count: number;
  symbols: string[];
  items: WatchlistAssetItem[];
  generated_at?: string;
}

export interface TrackedAssetSummary {
  symbol: string;
  asset_class: string;
  trade_date: string;
  close: number;
  change_1d_pct: number | null;
  volume: number;
}

export interface MacroTapeBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface MacroTapeItem {
  yahoo_symbol: string;
  proxy_symbol: string;
  name: string;
  zh_name: string;
  decimals: number;
  unit: string;
  price: number;
  prev_close: number;
  change_abs: number;
  change_pct: number;
  bars: MacroTapeBar[];
}

export interface MacroTapeResponse {
  status: string;
  source: string;
  is_stale?: boolean;
  fetched_at?: string;
  count: number;
  items: MacroTapeItem[];
}

const _RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const API_BASE =
  _RAW_API_BASE !== undefined ? _RAW_API_BASE.replace(/\/$/, "") : "http://localhost:8100";

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/health`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Health probe failed (${res.status})`);
  }
  return res.json();
}

export async function fetchArchitecture(): Promise<ArchitectureResponse> {
  const res = await fetch(`${API_BASE}/api/system/architecture`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Architecture fetch failed (${res.status})`);
  }
  return res.json();
}

export async function fetchDashboardOverview(): Promise<DashboardOverviewResponse> {
  const res = await fetch(`${API_BASE}/api/dashboard/overview`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Dashboard overview failed (${res.status})`);
  }
  return res.json();
}

export async function fetchTrackedAssets(): Promise<{
  count: number;
  assets: TrackedAssetSummary[];
}> {
  const res = await fetch(`${API_BASE}/api/assets`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Tracked assets failed (${res.status})`);
  }
  return res.json();
}

export async function fetchAssetDetail(
  symbol: string,
  barsLimit = 260,
  includeNews = true,
  ensureIfMissing = true
): Promise<AssetDetailResponse> {
  const params = new URLSearchParams({
    bars_limit: String(barsLimit),
    include_news: String(includeNews),
    ensure_if_missing: String(ensureIfMissing),
  });
  const res = await fetch(
    `${API_BASE}/api/assets/${encodeURIComponent(symbol)}?${params.toString()}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Asset ${symbol} failed (${res.status})`);
  }
  return res.json();
}

export async function ensureAsset(
  symbol: string,
  forceRefresh = false
): Promise<{
  status: string;
  symbol: string;
  found: boolean;
  bars_count: number;
  bars_status: string;
  gex_status: string;
  eps_status: string;
}> {
  const res = await fetch(
    `${API_BASE}/api/assets/${encodeURIComponent(symbol)}/ensure?force_refresh=${forceRefresh ? "true" : "false"}`,
    { method: "POST" }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Asset ensure failed (${res.status})`);
  }
  return res.json();
}

export async function fetchRegimeHistory(
  limit = 30
): Promise<{ count: number; history: RegimeHistoryPoint[] }> {
  const res = await fetch(`${API_BASE}/api/market/regime-history?limit=${limit}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Regime history failed (${res.status})`);
  }
  return res.json();
}

export async function fetchMacroTape(forceRefresh = false): Promise<MacroTapeResponse> {
  const res = await fetch(
    `${API_BASE}/api/market/macro-tape${forceRefresh ? "?force_refresh=true" : ""}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Macro tape failed (${res.status})`);
  }
  return res.json();
}

export function getAssetLogoUrl(symbol: string): string {
  return `${API_BASE}/api/assets/${encodeURIComponent(symbol.toUpperCase())}/logo`;
}

export async function fetchWatchlist(): Promise<WatchlistResponse> {
  const res = await fetch(`${API_BASE}/api/watchlist`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Watchlist failed (${res.status})`);
  }
  return res.json();
}

export async function updateWatchlist(symbols: string[]): Promise<WatchlistResponse> {
  const res = await fetch(`${API_BASE}/api/watchlist`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Watchlist update failed (${res.status})`);
  }
  return res.json();
}

export async function triggerPipelineSync(forceRefresh = false): Promise<{
  status: string;
  states: Record<string, string>;
  regime_label?: string;
}> {
  const res = await fetch(
    `${API_BASE}/api/pipeline/sync?force_refresh=${forceRefresh ? "true" : "false"}`,
    { method: "POST" }
  );
  if (!res.ok) {
    throw new Error(`Pipeline sync failed (${res.status})`);
  }
  return res.json();
}

export interface AgentStatusResponse {
  status: "ready" | "llm_key_required";
  llm_pro_ready: boolean;
  llm_fast_ready: boolean;
  llm_pro_model: string;
  llm_fast_model: string;
  telemetry_enabled: boolean;
  phoenix_ui_url: string | null;
  mcp_endpoint: string;
  mcp_tools: { name: string; description: string }[];
  sec_cached_filings: number;
  limits: {
    max_steps: number;
    wall_timeout_seconds: number;
    max_context_tokens: number;
    guest_rpm: number;
  };
}

export interface SecChunkResult {
  chunk_id: number;
  symbol: string;
  form_type: string;
  filing_date: string;
  section_title: string;
  rrf_score: number;
  lexical_rank: number | null;
  vector_rank: number | null;
  content: string;
}

export interface SecSearchResponse {
  symbol: string;
  query: string;
  mode: string;
  filings: {
    accession_number: string;
    form_type: string;
    filing_date: string;
    chunk_count: number;
    cached?: boolean;
  }[];
  chunks: SecChunkResult[];
}

export async function fetchAgentStatus(): Promise<AgentStatusResponse> {
  const res = await fetch(`${API_BASE}/api/agent/status`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Agent status failed (${res.status})`);
  }
  return res.json();
}

export async function searchSecFilings(payload: {
  symbol: string;
  query: string;
  form_type?: string | null;
  top_k?: number;
}): Promise<SecSearchResponse> {
  const res = await fetch(`${API_BASE}/api/rag/sec/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbol: payload.symbol,
      query: payload.query,
      form_type: payload.form_type || null,
      top_k: payload.top_k ?? 5,
      auto_ingest: true,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `SEC search failed (${res.status})`);
  }
  return res.json();
}

export interface InvestigateSseEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface TradeIntentInfo {
  detected: boolean;
  symbol?: string;
  side?: "buy" | "sell";
  proposed_qty?: number;
}

export interface RiskSizingPayload {
  symbol: string;
  side: string;
  account_equity: number;
  buying_power: number;
  risk_budget_pct: number;
  max_risk_dollars: number;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  stop_distance: number;
  proposed_qty: number;
  max_safe_qty: number;
  recommended_qty: number;
  was_capped_by_risk: boolean;
  was_capped_by_buying_power: boolean;
  estimated_notional: number;
  estimated_risk_dollars: number;
  risk_reward_ratio: number;
  bracket_valid: boolean;
  warnings: string[];
}

export interface RiskCritiquePayload {
  verdict: string;
  summary: string;
  counter_arguments: string[];
  regime_alignment: string;
  falsification_trigger: string;
  suggested_stop_loss: number | null;
  suggested_take_profit: number | null;
}

export interface RiskApprovalCard {
  type: string;
  thread_id: string;
  symbol: string;
  side: "buy" | "sell";
  rationale: string;
  risk_sizing: RiskSizingPayload;
  critique: RiskCritiquePayload;
  account?: {
    status?: string;
    equity?: number;
    buying_power?: number;
    cash?: number;
    paper?: boolean;
  };
  existing_position?: {
    symbol: string;
    qty: number;
    market_value: number;
    unrealized_pl: number;
  } | null;
  upcoming_catalysts?: {
    event_type: string;
    event_time: string;
    symbol: string | null;
    title: string;
    impact: string;
  }[];
}

export interface TradeProposeResponse {
  status: string;
  thread_id: string;
  trade_id: number | null;
  requires_admin_token: boolean;
  checkpointer: "postgres" | "memory" | string;
  approval_card: RiskApprovalCard;
}

export interface TradeResumeResponse {
  status: string;
  thread_id: string;
  error: string | null;
  receipt: Record<string, unknown>;
}

export interface TradeCheckpointResponse {
  thread_id: string;
  next_nodes: string[];
  is_suspended: boolean;
  requires_admin_token: boolean;
  approval_card: RiskApprovalCard;
  execution_status: string | null;
  execution_receipt: Record<string, unknown> | null;
}

export interface PaperLedgerResponse {
  checkpointer: string;
  requires_admin_token: boolean;
  alpaca_error: string | null;
  account: {
    id: string;
    status: string;
    currency: string;
    equity: number;
    cash: number;
    buying_power: number;
    portfolio_value: number;
    paper: boolean;
  } | null;
  positions: {
    symbol: string;
    qty: number;
    side: string;
    avg_entry_price: number;
    current_price: number;
    market_value: number;
    unrealized_pl: number;
    unrealized_plpc: number;
  }[];
  orders: {
    id: string;
    symbol: string;
    side: string;
    qty: string;
    order_class: string;
    type: string;
    status: string;
    filled_avg_price: string | null;
    created_at: string | null;
  }[];
  paper_trades: {
    id: number;
    thread_id: string | null;
    symbol: string;
    side: string;
    order_class: string;
    qty: number;
    entry_price: number | null;
    stop_loss_price: number | null;
    take_profit_price: number | null;
    risk_budget_pct: number;
    alpaca_order_id: string | null;
    status: string;
    regime_at_entry: string | null;
    rationale_summary: string;
    closed_at?: string | null;
    realized_pnl?: number | null;
    spy_benchmark_return_pct?: number | null;
    created_at: string;
  }[];
}

export interface WatchdogAlertRecord {
  id: number;
  alert_key: string;
  alert_type: string;
  severity: "high" | "medium" | "info" | string;
  symbol: string | null;
  title: string;
  summary_markdown: string;
  metrics: Record<string, unknown>;
  regime_label: string | null;
  acknowledged: boolean;
  created_at: string;
}

export interface TradeReviewRecord {
  id: number;
  paper_trade_id: number;
  symbol: string;
  side: string;
  realized_pnl: number | null;
  horizon: string;
  quadrant_outcome: string;
  alpha_vs_spy_pct: number | null;
  regime_label: string | null;
  lessons_markdown: string;
  created_at: string;
}

export interface EpisodicMemoryRecord {
  id: number;
  paper_trade_id: number | null;
  symbol: string;
  regime_label: string;
  quadrant_outcome: string;
  title: string;
  lesson_text: string;
  tags: string[];
  alpha_vs_spy_pct: number | null;
  created_at: string;
}

export interface GoldenEvalReport {
  status: string;
  generated_at: string;
  total_cases: number;
  passed_cases: number;
  pass_rate_pct: number;
  duration_ms: number;
  categories: Record<
    string,
    { total: number; passed: number; pass_rate_pct: number }
  >;
  results: {
    id: string;
    category: string;
    name: string;
    passed: boolean;
    elapsed_ms: number;
    observed: Record<string, unknown>;
  }[];
}

export async function proposeTrade(payload: {
  thread_id?: string | null;
  symbol: string;
  side: "buy" | "sell";
  proposed_qty: number;
  entry_price?: number | null;
  stop_loss_price?: number | null;
  take_profit_price?: number | null;
  risk_budget_pct?: number;
  rationale?: string;
}): Promise<TradeProposeResponse> {
  const res = await fetch(`${API_BASE}/api/trade/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Trade proposal failed (${res.status})`);
  }
  return res.json();
}

export async function resumeTrade(
  payload: {
    thread_id: string;
    decision: "approve" | "reject";
    approved_qty?: number | null;
    stop_loss_price?: number | null;
    take_profit_price?: number | null;
    limit_price?: number | null;
    note?: string;
  },
  adminToken?: string
): Promise<TradeResumeResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (adminToken && adminToken.trim()) {
    headers["X-Admin-Token"] = adminToken.trim();
  }
  const res = await fetch(`${API_BASE}/api/trade/resume`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HITL resume failed (${res.status})`);
  }
  return res.json();
}

export async function fetchTradeCheckpoint(threadId: string): Promise<TradeCheckpointResponse> {
  const res = await fetch(`${API_BASE}/api/trade/checkpoint/${encodeURIComponent(threadId)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Checkpoint load failed (${res.status})`);
  }
  return res.json();
}

export async function fetchTradeLedger(): Promise<PaperLedgerResponse> {
  const res = await fetch(`${API_BASE}/api/trade/ledger`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Paper ledger fetch failed (${res.status})`);
  }
  return res.json();
}

export async function streamInvestigate(
  payload: {
    thread_id: string;
    query: string;
    symbol?: string | null;
    history?: { role: "user" | "assistant"; content: string }[];
  },
  onEvent: (ev: InvestigateSseEvent) => void
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agent/investigate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
    throw new Error(err.detail || `Investigation failed (${res.status})`);
  }
  if (!res.body) {
    throw new Error("Empty SSE stream body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let evName = "message";
      let dataRaw = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) {
          evName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataRaw += line.slice(5).trim();
        }
      }
      if (!dataRaw) continue;
      try {
        const parsed = JSON.parse(dataRaw) as Record<string, unknown>;
        onEvent({ event: evName, data: parsed });
      } catch {
        // Skip malformed partial frame cleanly
      }
    }
  }
}

export async function cancelPaperOrder(
  orderId: string,
  adminToken?: string | null
): Promise<{ status: string; updated_trades: number }> {
  const headers: Record<string, string> = {};
  if (adminToken && adminToken.trim()) {
    headers["X-Admin-Token"] = adminToken.trim();
  }
  const res = await fetch(
    `${API_BASE}/api/trade/orders/${encodeURIComponent(orderId)}/cancel`,
    { method: "POST", headers }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Order cancel failed (${res.status})`);
  }
  return res.json();
}

export async function closePaperPosition(
  symbol: string,
  adminToken?: string | null
): Promise<{ status: string; symbol: string; closed_trade_ids: number[] }> {
  const headers: Record<string, string> = {};
  if (adminToken && adminToken.trim()) {
    headers["X-Admin-Token"] = adminToken.trim();
  }
  const res = await fetch(
    `${API_BASE}/api/trade/positions/${encodeURIComponent(symbol)}/close`,
    { method: "POST", headers }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Close position failed (${res.status})`);
  }
  return res.json();
}

export async function syncPaperTradesStatus(): Promise<{
  status: string;
  checked: number;
  updated: number;
  newly_closed_trade_ids: number[];
}> {
  const res = await fetch(`${API_BASE}/api/trade/sync-status`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Trade status sync failed (${res.status})`);
  }
  return res.json();
}

export async function fetchWatchdogAlerts(limit = 20): Promise<{
  count: number;
  alerts: WatchdogAlertRecord[];
}> {
  const res = await fetch(`${API_BASE}/api/watchdog/alerts?limit=${limit}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Watchdog alerts fetch failed (${res.status})`);
  }
  return res.json();
}

export async function triggerWatchdogScan(useFastLlm = true): Promise<{
  status: string;
  scanned_symbols: number;
  alerts_upserted: number;
  regime_label: string;
  scanned_at: string;
}> {
  const res = await fetch(
    `${API_BASE}/api/watchdog/scan?use_fast_llm=${useFastLlm ? "true" : "false"}`,
    { method: "POST" }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Watchdog scan failed (${res.status})`);
  }
  return res.json();
}

export async function ackWatchdogAlert(alertId: number): Promise<{ status: string }> {
  const res = await fetch(`${API_BASE}/api/watchdog/alerts/${alertId}/ack`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Ack alert failed (${res.status})`);
  }
  return res.json();
}

export async function fetchTradeReviews(limit = 20): Promise<{
  reviews: TradeReviewRecord[];
  memories: EpisodicMemoryRecord[];
}> {
  const res = await fetch(`${API_BASE}/api/reviews?limit=${limit}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Trade reviews fetch failed (${res.status})`);
  }
  return res.json();
}

export async function reflectOnTrade(
  tradeId: number,
  horizon: "POST_CLOSE" | "T+5" | "T+20" = "POST_CLOSE"
): Promise<{
  status: string;
  review_id: number;
  quadrant_outcome: string;
  quadrant_cn: string;
  alpha_vs_spy_pct: number | null;
  lessons_markdown: string;
}> {
  const res = await fetch(`${API_BASE}/api/reviews/${tradeId}/reflect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ horizon, use_fast_llm: true }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Reflection failed (${res.status})`);
  }
  return res.json();
}

export async function recallEpisodicMemories(
  query: string,
  symbol?: string | null
): Promise<{ count: number; memories: EpisodicMemoryRecord[] }> {
  const params = new URLSearchParams({ query, top_k: "6" });
  if (symbol) params.set("symbol", symbol);
  const res = await fetch(`${API_BASE}/api/memories/recall?${params.toString()}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Memory recall failed (${res.status})`);
  }
  return res.json();
}

export async function fetchLatestEvalReport(): Promise<GoldenEvalReport> {
  const res = await fetch(`${API_BASE}/api/evals/latest`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Eval report fetch failed (${res.status})`);
  }
  return res.json();
}

export async function runGoldenEvals(): Promise<GoldenEvalReport> {
  const res = await fetch(`${API_BASE}/api/evals/run`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Eval run failed (${res.status})`);
  }
  return res.json();
}
