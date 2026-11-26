import { getBrokerHeaders, getByokHeaders, getWorkspaceHeaders } from "@/lib/clientSettings";

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
  spy_close?: number | null;
}

export interface VixOhlcBar {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface VixPulseSnapshot {
  symbol: string;
  price: number;
  prev_close: number;
  change_abs: number;
  change_pct: number;
  as_of_date: string;
  peak_high: number;
  peak_date: string;
  period_low: number;
  period_low_date: string;
  bars: VixOhlcBar[];
}

export interface SimpleSpotMetric {
  symbol: string;
  price: number;
  prev_close: number;
  change_abs: number;
  change_pct: number;
  as_of_date: string;
}

export interface CnnFearGreedSnapshot {
  source: string;
  score: number | null;
  label: string;
  timestamp?: string | null;
  previous_close?: number | null;
  previous_1_week?: number | null;
  previous_1_month?: number | null;
  previous_1_year?: number | null;
  components: Record<string, number | null>;
  component_ratings?: Record<string, string>;
  component_raw_values?: Record<string, number | null>;
  is_stale?: boolean;
}

export interface SentimentPulseResponse {
  status: string;
  fear_greed: CnnFearGreedSnapshot | null;
  vix: VixPulseSnapshot | null;
  dxy: SimpleSpotMetric | null;
  tnx: SimpleSpotMetric | null;
  spy_closes: { date: string; close: number }[];
  fetched_at?: string | null;
}

export interface AssetTechnicals {
  available: boolean;
  as_of_date?: string;
  last_close?: number;
  prev_close?: number;
  change_1d_pct?: number | null;
  change_5d_pct?: number | null;
  change_20d_pct?: number | null;
  change_ytd_pct?: number | null;
  ema_5?: number | null;
  ema_9?: number | null;
  ema_10?: number | null;
  ema_20?: number | null;
  sma_50?: number | null;
  sma_200?: number | null;
  dist_50ma_pct?: number | null;
  dist_200ma_pct?: number | null;
  high_52w?: number | null;
  dist_52w_high_pct?: number | null;
  rsi_14?: number | null;
  macd?: {
    macd: number;
    signal: number;
    histogram: number;
    prev_histogram?: number;
  } | null;
  bollinger?: {
    upper: number;
    middle: number;
    lower: number;
    bandwidth_pct: number;
  } | null;
  atr_14?: number | null;
  atr_pct?: number | null;
  rvol_20?: number | null;
  volume_price_tag?: string;
  sparkline_bars?: MacroTapeBar[];
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

export interface PriceTargetConsensus {
  symbol: string;
  target_consensus: number | null;
  target_median: number | null;
  target_high: number | null;
  target_low: number | null;
  source?: string;
}

export interface ExtendedHoursQuote {
  session: "pre" | "post" | "regular";
  label_zh: string;
  price: number;
  change_pct: number | null;
  regular_price?: number | null;
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
  price_target?: PriceTargetConsensus | null;
  extended_hours?: ExtendedHoursQuote | null;
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
  extended_hours?: ExtendedHoursQuote | null;
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

export interface DiscoverRelatedArticle {
  source: string;
  title_zh: string;
  headline_en: string;
  url: string;
  published_at: string;
}

export interface DiscoverArticleParagraph {
  index: number;
  en: string;
  zh: string;
}

export interface DiscoverArticleBlock {
  type: "callout" | "heading" | "quote" | "list" | "paragraph";
  en?: string;
  zh?: string;
  items_en?: string[];
  items_zh?: string[];
  ordered?: boolean;
}

export interface DiscoverNewsItem {
  id: string;
  title_zh: string;
  headline_en: string;
  summary_zh?: string;
  category_zh: string;
  source: string;
  sources: string[];
  source_count: number;
  url: string;
  image_proxy_url: string;
  published_at: string;
  related_articles?: DiscoverRelatedArticle[];
}

export interface DiscoverArticleDetail {
  status: string;
  id: string;
  title_zh: string;
  headline_en: string;
  category_zh: string;
  source: string;
  sources: string[];
  source_count: number;
  url: string;
  image_proxy_url: string;
  published_at: string;
  access_status: "full" | "summary_only";
  blocks?: DiscoverArticleBlock[];
  paragraphs: DiscoverArticleParagraph[];
  related_articles: DiscoverRelatedArticle[];
  cached?: boolean;
}

export interface DiscoverNewsResponse {
  status: string;
  cache_source: string;
  fetched_at?: string | null;
  translated: boolean;
  count: number;
  items: DiscoverNewsItem[];
}

const _RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
const API_BASE =
  _RAW_API_BASE !== undefined ? _RAW_API_BASE.replace(/\/$/, "") : "http://localhost:8100";

export function resolveApiUrl(path: string): string {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}

export async function fetchDiscoverNews(
  limit = 21,
  forceRefresh = false
): Promise<DiscoverNewsResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    force_refresh: forceRefresh ? "true" : "false",
  });
  const res = await fetch(`${API_BASE}/api/market/discover?${params.toString()}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Discover news failed (${res.status})`);
  }
  return res.json();
}

export async function fetchDiscoverArticleDetail(
  articleId: string,
  forceRefresh = false
): Promise<DiscoverArticleDetail> {
  const qs = forceRefresh ? "?force_refresh=true" : "";
  const res = await fetch(
    `${API_BASE}/api/market/discover/${encodeURIComponent(articleId)}${qs}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Article detail failed (${res.status})`);
  }
  return res.json();
}

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

export async function fetchSentimentPulse(
  forceRefresh = false
): Promise<SentimentPulseResponse> {
  const res = await fetch(
    `${API_BASE}/api/market/sentiment-pulse${forceRefresh ? "?force_refresh=true" : ""}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Sentiment pulse failed (${res.status})`);
  }
  return res.json();
}

export function getAssetLogoUrl(symbol: string): string {
  return `${API_BASE}/api/assets/${encodeURIComponent(symbol.toUpperCase())}/logo`;
}

export async function fetchWatchlist(): Promise<WatchlistResponse> {
  const res = await fetch(`${API_BASE}/api/watchlist`, {
    cache: "no-store",
    headers: getWorkspaceHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Watchlist failed (${res.status})`);
  }
  return res.json();
}

export async function updateWatchlist(symbols: string[]): Promise<WatchlistResponse> {
  const res = await fetch(`${API_BASE}/api/watchlist`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...getWorkspaceHeaders() },
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
  key_source?: "byok" | "server" | "none";
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

export interface TestConnectionResponse {
  ok: boolean;
  latency_ms: number;
  model: string;
  base_url: string;
  reply_preview: string;
}

export interface LiveModelItem {
  id: string;
  owned_by?: string;
  name?: string;
}

export interface MacroReleaseRecord {
  period: string;
  label_zh: string;
  actual_value: number;
  actual_display: string;
  previous_display: string | null;
  secondary_label: string | null;
  secondary_display: string | null;
  mom_display: string | null;
  delta_display: string | null;
  trend: "up" | "down" | "flat";
}

export interface MacroIndicatorHistory {
  id: string;
  title_zh: string;
  short_zh: string;
  subtitle_en: string;
  source_tag: string;
  unit_zh: string;
  latest_period_zh: string;
  latest_display: string;
  previous_display: string | null;
  secondary_badge: string | null;
  delta_display: string | null;
  trend: "up" | "down" | "flat";
  summary_line_zh: string;
  records: MacroReleaseRecord[];
}

export interface LiveBackendCalendarEvent {
  event_key: string;
  event_type: "macro" | "earnings" | string;
  event_time: string;
  symbol: string | null;
  title: string;
  impact: string;
  actual?: number | null;
  estimate?: number | null;
  previous?: number | null;
  previous_summary?: string | null;
  indicator_id?: string | null;
  eps_actual?: number | null;
  eps_estimate?: number | null;
  source?: string;
}

export interface UpcomingCalendarResponse {
  status: string;
  watchlist_symbols: string[];
  macro_events: LiveBackendCalendarEvent[];
  earnings_events: LiveBackendCalendarEvent[];
  upcoming_events: LiveBackendCalendarEvent[];
  macro_history?: MacroIndicatorHistory[];
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
  const res = await fetch(`${API_BASE}/api/agent/status`, {
    cache: "no-store",
    headers: getByokHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Agent status failed (${res.status})`);
  }
  return res.json();
}

export async function testAgentConnection(payload: {
  api_key: string;
  base_url: string;
  model: string;
}): Promise<TestConnectionResponse> {
  const res = await fetch(`${API_BASE}/api/agent/test-connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Connection test failed (${res.status})`);
  }
  return res.json();
}

export async function fetchByokModels(payload: {
  api_key: string;
  base_url: string;
}): Promise<{ ok: boolean; count: number; models: LiveModelItem[] }> {
  const res = await fetch(`${API_BASE}/api/agent/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Fetch models failed (${res.status})`);
  }
  return res.json();
}

export async function fetchUpcomingCalendar(): Promise<UpcomingCalendarResponse> {
  const res = await fetch(`${API_BASE}/api/calendar/upcoming`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Calendar fetch failed (${res.status})`);
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
  structure_levels?: {
    spot_price?: number | null;
    atr_14?: number | null;
    ema_20?: number | null;
    sma_50?: number | null;
    call_wall?: number | null;
    put_wall?: number | null;
    zero_gamma?: number | null;
    net_gex?: number | null;
  };
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

export interface BrokerProfileMeta {
  id: string;
  display_name: string;
  short_name: string;
  badge: string;
  mode: "sandbox" | "read_only" | "paper_exec" | string;
  supports_history_sync: boolean;
  supports_manual_ticket: boolean;
  sync_button_label: string;
  positions_title: string;
  ledger_title: string;
  empty_positions_hint: string;
  ticket_label: string;
}

export interface PaperLedgerResponse {
  checkpointer: string;
  requires_admin_token: boolean;
  workspace_id?: string;
  broker?: string;
  broker_label?: string;
  broker_profile?: BrokerProfileMeta | null;
  read_only?: boolean;
  currency?: string;
  alpaca_error: string | null;
  broker_error?: string | null;
  account: {
    id: string;
    status: string;
    currency: string;
    equity: number;
    cash: number;
    buying_power: number;
    portfolio_value: number;
    invested_value?: number;
    unrealized_pl?: number;
    realized_pl?: number;
    paper: boolean;
    broker?: string;
    read_only?: boolean;
  } | null;
  positions: {
    symbol: string;
    raw_ticker?: string;
    name?: string;
    qty: number;
    side: string;
    avg_entry_price: number;
    current_price: number;
    market_value: number;
    unrealized_pl: number;
    unrealized_plpc: number;
    currency?: string;
    stop_loss_price?: number | null;
    take_profit_price?: number | null;
    sl_is_estimated?: boolean;
    zero_gamma?: number | null;
    call_wall?: number | null;
    put_wall?: number | null;
  }[];
  orders: {
    id: string;
    symbol: string;
    raw_ticker?: string;
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

export interface Trading212TestResponse {
  ok: boolean;
  env: string;
  currency: string;
  equity: number;
  cash: number;
  unrealized_pl: number;
  positions_count: number;
  pending_orders_count: number;
  warnings: string[];
}

export interface InvestigatorThreadSummary {
  thread_id: string;
  symbol: string | null;
  title: string;
  turn_count: number;
  tool_count: number;
  memory_count: number;
  updated_at: string;
  created_at: string;
}

export interface InvestigatorThreadDetail {
  thread_id: string;
  symbol: string | null;
  title: string;
  messages: { role: "user" | "assistant"; content: string }[];
  tool_traces: {
    tool: string;
    args?: Record<string, unknown>;
    status: string;
    latency_ms?: number;
    preview?: string;
    output?: string;
  }[];
  memory_hits: {
    id?: number;
    symbol?: string;
    regime_label?: string;
    quadrant_outcome?: string;
    title?: string;
    lesson_text?: string;
    alpha_vs_spy_pct?: number | null;
  }[];
  trade_intent?: TradeIntentInfo | null;
  updated_at: string;
  created_at: string;
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
  is_pinned?: boolean;
  is_active?: boolean;
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

export async function testTrading212Connection(payload: {
  api_key: string;
  api_secret: string;
  env: "live" | "demo";
}): Promise<Trading212TestResponse> {
  const res = await fetch(`${API_BASE}/api/trade/trading212/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getBrokerHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Trading212 test failed (${res.status})`);
  }
  return res.json();
}

export async function fetchInvestigatorThreads(limit = 15): Promise<{
  count: number;
  threads: InvestigatorThreadSummary[];
}> {
  const res = await fetch(`${API_BASE}/api/agent/threads?limit=${limit}`, {
    cache: "no-store",
    headers: getWorkspaceHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Threads list failed (${res.status})`);
  }
  return res.json();
}

export async function fetchInvestigatorThreadDetail(
  threadId: string
): Promise<InvestigatorThreadDetail> {
  const res = await fetch(`${API_BASE}/api/agent/threads/${encodeURIComponent(threadId)}`, {
    cache: "no-store",
    headers: getWorkspaceHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Thread load failed (${res.status})`);
  }
  return res.json();
}

export async function deleteInvestigatorThread(threadId: string): Promise<void> {
  await fetch(`${API_BASE}/api/agent/threads/${encodeURIComponent(threadId)}`, {
    method: "DELETE",
    headers: getWorkspaceHeaders(),
  });
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
    headers: { "Content-Type": "application/json", ...getByokHeaders(), ...getBrokerHeaders() },
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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...getBrokerHeaders(),
  };
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
    headers: getBrokerHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Checkpoint load failed (${res.status})`);
  }
  return res.json();
}

export async function fetchTradeLedger(forceRefresh = false): Promise<PaperLedgerResponse> {
  const res = await fetch(
    `${API_BASE}/api/trade/ledger${forceRefresh ? "?force_refresh=true" : ""}`,
    {
      cache: "no-store",
      headers: getBrokerHeaders(),
    }
  );
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
    headers: { "Content-Type": "application/json", ...getByokHeaders(), ...getBrokerHeaders() },
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
  const headers: Record<string, string> = { ...getBrokerHeaders() };
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
  const headers: Record<string, string> = { ...getBrokerHeaders() };
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
  broker?: string;
  checked: number;
  updated: number;
  newly_closed_trade_ids: number[];
}> {
  const res = await fetch(`${API_BASE}/api/trade/sync-status`, {
    method: "POST",
    headers: getBrokerHeaders(),
  });
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
    headers: getWorkspaceHeaders(),
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
    { method: "POST", headers: { ...getByokHeaders(), ...getWorkspaceHeaders() } }
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
    headers: getWorkspaceHeaders(),
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
  const res = await fetch(`${API_BASE}/api/reviews?limit=${limit}`, {
    cache: "no-store",
    headers: getWorkspaceHeaders(),
  });
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
    headers: { "Content-Type": "application/json", ...getByokHeaders(), ...getWorkspaceHeaders() },
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
    headers: getWorkspaceHeaders(),
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

export interface InstitutionalGroupPosition {
  label: string;
  long: number;
  short: number;
  spread?: number;
  net: number;
  wow_change: number | null;
  pct_oi?: number | null;
  long_short_ratio?: number | null;
  percentile_52w?: number | null;
}

export interface InstitutionalSeriesPoint {
  date: string;
  real_money_net: number;
  leveraged_net: number;
  dealer_net: number;
}

export interface InstitutionalContractFlow {
  symbol: string;
  name: string;
  name_zh: string;
  asset_bucket: string;
  report_date: string;
  open_interest: number;
  divergence: boolean;
  crowded_signal: string;
  crowded_badge_zh: string;
  headline_zh: string;
  detail_zh: string;
  real_money: InstitutionalGroupPosition;
  leveraged: InstitutionalGroupPosition;
  dealer: InstitutionalGroupPosition;
  series_26w: InstitutionalSeriesPoint[];
}

export interface InstitutionalFlowResponse {
  status: string;
  report_date: string | null;
  summary_zh: string;
  contracts: Record<string, InstitutionalContractFlow>;
  source?: string;
}

export interface OptionsRadarStrikeRow {
  strike: number;
  call_gex: number;
  put_gex: number;
  net_gex: number;
  call_oi: number;
  put_oi: number;
  call_vol: number;
  put_vol: number;
  call_iv: number | null;
  put_iv: number | null;
}

export interface OptionsUnusualFlowItem {
  contract_symbol: string;
  option_type: "call" | "put" | string;
  strike: number;
  expiration_date: string | null;
  dte: number;
  volume: number;
  open_interest: number;
  vol_oi_ratio: number;
  iv_pct: number | null;
  delta: number | null;
  last_price: number | null;
  est_premium_usd: number | null;
}

export type OptionsExpiryBucket = "all" | "0dte" | "weekly" | "monthly";

export interface OptionsRadarResponse {
  status: string;
  symbol: string;
  bucket: OptionsExpiryBucket | string;
  reason?: string;
  bucket_counts?: Record<string, number>;
  spot_price?: number;
  anchor_expiry?: string | null;
  anchor_dte?: number;
  net_gex?: number;
  call_wall?: number | null;
  put_wall?: number | null;
  zero_gamma?: number | null;
  max_pain?: number | null;
  atm_iv_pct?: number | null;
  expected_move_abs?: number | null;
  expected_move_pct?: number | null;
  expected_low?: number | null;
  expected_high?: number | null;
  iv_skew_25d?: number | null;
  put_call_ratio?: number | null;
  put_call_vol_ratio?: number | null;
  total_call_oi?: number;
  total_put_oi?: number;
  total_call_vol?: number;
  total_put_vol?: number;
  contracts_analyzed?: number;
  dealer_regime?: string;
  dealer_regime_zh?: string;
  battle_summary_zh?: string;
  strike_profile: OptionsRadarStrikeRow[];
  unusual_flow: OptionsUnusualFlowItem[];
}

export interface SectorConstituentItem {
  symbol: string;
  name_zh: string;
  weight_pct: number;
  price: number | null;
  change_1d_pct: number | null;
}

export interface SectorHeatmapItem {
  symbol: string;
  name_zh: string;
  short_zh: string;
  market_weight_pct: number;
  price: number | null;
  return_1d_pct: number | null;
  return_5d_pct: number | null;
  return_20d_pct: number | null;
  rel_spy_20d_pct: number | null;
  advancers_top6: number;
  constituents: SectorConstituentItem[];
}

export interface SectorHeatmapResponse {
  status: string;
  source: string;
  summary_zh: string;
  sectors: SectorHeatmapItem[];
}

export async function fetchInstitutionalFlow(
  forceRefresh = false
): Promise<InstitutionalFlowResponse> {
  const res = await fetch(
    `${API_BASE}/api/market/institutional-flow?force_refresh=${forceRefresh ? "true" : "false"}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Institutional flow fetch failed (${res.status})`);
  }
  return res.json();
}

export async function fetchOptionsRadar(
  symbol: string,
  bucket: OptionsExpiryBucket = "all",
  forceRefresh = false
): Promise<OptionsRadarResponse> {
  const sym = encodeURIComponent(symbol.toUpperCase().trim());
  const res = await fetch(
    `${API_BASE}/api/market/options-radar?symbol=${sym}&bucket=${bucket}&force_refresh=${forceRefresh ? "true" : "false"}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Options radar fetch failed (${res.status})`);
  }
  return res.json();
}

export async function fetchSectorHeatmap(
  forceRefresh = false
): Promise<SectorHeatmapResponse> {
  const res = await fetch(
    `${API_BASE}/api/market/sector-heatmap?force_refresh=${forceRefresh ? "true" : "false"}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Sector heatmap fetch failed (${res.status})`);
  }
  return res.json();
}

export interface CoreBenchmarkItem {
  symbol: string;
  display_symbol: string;
  name_zh: string;
  role_zh: string;
  last_close: number | null;
  prev_close: number | null;
  change_1d_pct: number | null;
  change_5d_pct: number | null;
  change_20d_pct: number | null;
  change_ytd_pct?: number | null;
  rsi_14: number | null;
  dist_50ma_pct: number | null;
  dist_52w_high_pct: number | null;
  macd_hist?: number | null;
  macd_prev_hist?: number | null;
  atr_pct?: number | null;
  rvol_20?: number | null;
  extended_hours?: ExtendedHoursQuote | null;
  sparkline_bars: MacroTapeBar[];
}

export interface CoreBenchmarksResponse {
  status: string;
  items: CoreBenchmarkItem[];
}

export interface IntradayBarPoint {
  time: number;
  session?: "pre" | "regular" | "post";
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
}

export interface AssetIntradayResponse {
  status: string;
  symbol: string;
  tf: "1d" | "5d" | string;
  interval: string;
  spot_price?: number | null;
  prev_close?: number | null;
  extended_hours?: ExtendedHoursQuote | null;
  bars: IntradayBarPoint[];
}

export interface MarketMoverItem {
  symbol: string;
  name_zh: string;
  theme_zh: string;
  price: number;
  change_1d_pct: number;
  rvol: number;
  dollar_vol_m: number;
  volume_m?: number;
  is_market_wide?: boolean;
}

export interface MarketMoversResponse {
  status: string;
  universe_count: number;
  screener_active?: boolean;
  min_price?: number;
  as_of: string;
  summary_zh: string;
  top_gainers: MarketMoverItem[];
  top_losers: MarketMoverItem[];
  unusual_volume: MarketMoverItem[];
  is_stale?: boolean;
}

export async function fetchMarketMovers(
  forceRefresh = false,
  minPrice = 2.0
): Promise<MarketMoversResponse> {
  const res = await fetch(
    `${API_BASE}/api/market/movers?min_price=${minPrice}&force_refresh=${forceRefresh ? "true" : "false"}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Market movers fetch failed (${res.status})`);
  }
  return res.json();
}

export async function fetchCoreBenchmarks(
  forceRefresh = false
): Promise<CoreBenchmarksResponse> {
  const res = await fetch(
    `${API_BASE}/api/market/core-benchmarks?force_refresh=${forceRefresh ? "true" : "false"}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Core benchmarks fetch failed (${res.status})`);
  }
  return res.json();
}

export async function fetchAssetIntraday(
  symbol: string,
  tf: "1d" | "5d" = "1d",
  forceRefresh = false
): Promise<AssetIntradayResponse> {
  const sym = encodeURIComponent(symbol.toUpperCase().trim());
  const res = await fetch(
    `${API_BASE}/api/assets/${sym}/intraday?tf=${tf}&force_refresh=${forceRefresh ? "true" : "false"}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Intraday bars fetch failed (${res.status})`);
  }
  return res.json();
}

export interface RiskPrefillDraft {
  symbol: string;
  side: "buy" | "sell";
  qty?: number;
  entryPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  riskBudgetPct?: number;
  rationale?: string;
  nonce: number;
}

export interface DebateKeyLevels {
  spot_price: number;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  put_wall?: number | null;
  zero_gamma?: number | null;
  call_wall?: number | null;
  ema_20?: number | null;
  sma_50?: number | null;
  atr_14?: number | null;
}

export interface DebateReportResponse {
  symbol: string;
  side: "buy" | "sell";
  mode: "llm_adversarial" | "deterministic_stress_test" | string;
  broker_label: string;
  currency: string;
  account_equity: number;
  spot_price: number;
  regime_label: string;
  regime_zh?: string;
  latency_ms: number;
  verdict: "BULL_FAVORED_WITH_CAP" | "BALANCED_CONTESTED" | "CRO_CAUTION_DEFER" | string;
  conviction_score: number;
  risk_temperature: "LOW" | "ELEVATED" | "EXTREME" | string;
  key_insights?: string[];
  bull_case: {
    headline: string;
    catalysts: string[];
    entry_zone: [number, number];
    target_price: number;
  };
  bear_case: {
    headline: string;
    counter_arguments: string[];
    invalidation_price: number;
    key_risk_tags: string[];
    risk_tags_zh?: string[];
  };
  cro_verdict: {
    summary: string;
    max_safe_qty: number;
    suggested_stop_loss: number;
    suggested_take_profit: number;
    risk_reward_ratio: number;
    risk_budget_pct: number;
    max_risk_dollars: number;
    estimated_notional: number;
    falsification_trigger: string;
  };
  key_levels: DebateKeyLevels;
  upcoming_catalysts: {
    event_type: string;
    event_time: string;
    symbol: string | null;
    title: string;
    impact: string;
  }[];
  memory_hits: {
    id?: number;
    symbol?: string;
    regime_label?: string;
    quadrant_outcome?: string;
    title?: string;
    lesson_text?: string;
    alpha_vs_spy_pct?: number | null;
  }[];
  sec_snippets: string[];
}

export interface RiskStructureResponse {
  symbol: string;
  side: "buy" | "sell";
  broker: string;
  currency: string;
  account_equity: number;
  buying_power: number;
  structure: {
    spot_price: number;
    atr_14?: number | null;
    atr_pct?: number | null;
    ema_20?: number | null;
    sma_50?: number | null;
    call_wall?: number | null;
    put_wall?: number | null;
    zero_gamma?: number | null;
    net_gex?: number | null;
    regime_label?: string;
  };
  risk_sizing: RiskSizingPayload;
}

export interface EquityCurvePoint {
  date: string;
  equity: number;
  portfolio_return_pct: number;
  spy_return_pct: number;
  drawdown_pct: number;
}

export interface QuadrantScatterPoint {
  trade_id: number;
  symbol: string;
  side: string;
  qty: number;
  quadrant: string;
  quadrant_cn: string;
  process_score: number;
  return_pct: number;
  alpha_vs_spy_pct?: number | null;
  realized_pnl: number;
  regime_label: string;
  closed_at: string;
}

export interface PortfolioAnalyticsKpis {
  closed_trades: number;
  win_count: number;
  loss_count: number;
  win_rate_pct: number;
  gross_profit: number;
  gross_loss: number;
  net_realized_pnl: number;
  profit_factor: number | null;
  avg_process_score: number | null;
  portfolio_return_pct: number;
  spy_return_pct: number;
  excess_alpha_pct: number;
  max_drawdown_pct: number;
}

export interface PortfolioAnalyticsResponse {
  status: string;
  broker: string;
  currency: string;
  has_sufficient_real_history: boolean;
  kpis: PortfolioAnalyticsKpis;
  equity_curve: EquityCurvePoint[];
  quadrant_points: QuadrantScatterPoint[];
  quadrant_counts: Record<string, number>;
  demo_preview: {
    currency: string;
    kpis: PortfolioAnalyticsKpis;
    equity_curve: EquityCurvePoint[];
    quadrant_points: QuadrantScatterPoint[];
    quadrant_counts: Record<string, number>;
  };
}

export async function runAgentDebate(payload: {
  symbol: string;
  side?: "buy" | "sell";
  risk_budget_pct?: number;
  thesis_hint?: string;
}): Promise<DebateReportResponse> {
  const res = await fetch(`${API_BASE}/api/agent/debate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getByokHeaders(), ...getBrokerHeaders() },
    body: JSON.stringify({
      symbol: payload.symbol.trim().toUpperCase(),
      side: payload.side ?? "buy",
      risk_budget_pct: payload.risk_budget_pct ?? 1.0,
      thesis_hint: payload.thesis_hint ?? "",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Debate failed (${res.status})`);
  }
  return res.json();
}

export async function fetchRiskStructure(
  symbol: string,
  params?: {
    side?: "buy" | "sell";
    risk_budget_pct?: number;
    entry_price?: number | null;
    stop_loss?: number | null;
    take_profit?: number | null;
    proposed_qty?: number;
  }
): Promise<RiskStructureResponse> {
  const sym = encodeURIComponent(symbol.trim().toUpperCase());
  const qs = new URLSearchParams();
  if (params?.side) qs.set("side", params.side);
  if (params?.risk_budget_pct) qs.set("risk_budget_pct", String(params.risk_budget_pct));
  if (params?.entry_price) qs.set("entry_price", String(params.entry_price));
  if (params?.stop_loss) qs.set("stop_loss", String(params.stop_loss));
  if (params?.take_profit) qs.set("take_profit", String(params.take_profit));
  if (params?.proposed_qty) qs.set("proposed_qty", String(params.proposed_qty));
  const res = await fetch(`${API_BASE}/api/trade/risk-structure/${sym}?${qs.toString()}`, {
    cache: "no-store",
    headers: getBrokerHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Risk structure failed (${res.status})`);
  }
  return res.json();
}

export async function fetchTradeAnalytics(): Promise<PortfolioAnalyticsResponse> {
  const res = await fetch(`${API_BASE}/api/trade/analytics`, {
    cache: "no-store",
    headers: getBrokerHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Portfolio analytics failed (${res.status})`);
  }
  return res.json();
}

export interface WatchdogAutopilotRunSummary {
  ok: boolean;
  trigger: string;
  ran_at: string;
  scanned_symbols: number;
  alerts_upserted: number;
  reflected_count: number;
  duration_ms: number;
  error: string | null;
}

export interface WatchdogAutopilotStatus {
  enabled: boolean;
  status: "online" | "paused" | "scanning" | string;
  interval_seconds: number;
  run_24_7: boolean;
  market_window_open: boolean;
  running_now: boolean;
  run_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  seconds_to_next_run: number | null;
  last_summary: WatchdogAutopilotRunSummary | null;
  recent_runs: WatchdogAutopilotRunSummary[];
}

export interface PortfolioPostmortemReport {
  status: string;
  mode: string;
  closed_trades_analyzed: number;
  total_net_pnl: number;
  avg_process_score: number | null;
  active_pinned_rules: number;
  regime_breakdown: {
    regime_label: string;
    trades: number;
    win_rate_pct: number;
    net_pnl: number;
    avg_process_score: number;
  }[];
  failure_patterns: string[];
  recommended_rules: {
    symbol: string;
    regime_label: string;
    title: string;
    lesson_text: string;
  }[];
  summary_markdown: string;
}

export interface BatchTradeProposalResponse {
  status: string;
  broker: string;
  queued_count: number;
  failed_count: number;
  proposals: {
    thread_id: string;
    trade_id: number | null;
    symbol: string;
    side: string;
    proposed_qty: number;
    recommended_qty: number | null;
    stop_loss_price: number | null;
    take_profit_price: number | null;
    verdict: string | null;
  }[];
  errors: { symbol: string; detail: string }[];
}

export async function fetchAutopilotStatus(): Promise<WatchdogAutopilotStatus> {
  const res = await fetch(`${API_BASE}/api/watchdog/autopilot/status`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Autopilot status failed (${res.status})`);
  }
  return res.json();
}

export async function configureAutopilot(payload: {
  enabled?: boolean;
  interval_seconds?: number;
  run_24_7?: boolean;
}): Promise<WatchdogAutopilotStatus> {
  const res = await fetch(`${API_BASE}/api/watchdog/autopilot/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Autopilot config failed (${res.status})`);
  }
  return res.json();
}

export async function runAutopilotNow(): Promise<
  WatchdogAutopilotStatus & { last_run?: WatchdogAutopilotRunSummary }
> {
  const res = await fetch(`${API_BASE}/api/watchdog/autopilot/run-now`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Autopilot run failed (${res.status})`);
  }
  return res.json();
}

export async function runPortfolioPostmortem(payload?: {
  use_fast_llm?: boolean;
  lookback_limit?: number;
}): Promise<PortfolioPostmortemReport> {
  const res = await fetch(`${API_BASE}/api/reviews/portfolio-postmortem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getByokHeaders(), ...getWorkspaceHeaders() },
    body: JSON.stringify({
      use_fast_llm: payload?.use_fast_llm ?? true,
      lookback_limit: payload?.lookback_limit ?? 30,
    }),
  });
  if (!res.ok) {
    throw new Error(`Portfolio postmortem failed (${res.status})`);
  }
  return res.json();
}

export async function createPlaybookRule(payload: {
  symbol?: string;
  regime_label?: string;
  quadrant_outcome?: string;
  title: string;
  lesson_text: string;
  is_pinned?: boolean;
  is_active?: boolean;
}): Promise<{ status: string; memory: EpisodicMemoryRecord }> {
  const res = await fetch(`${API_BASE}/api/memories/playbook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getWorkspaceHeaders() },
    body: JSON.stringify({
      symbol: payload.symbol || "ALL",
      regime_label: payload.regime_label || "HIGH_VOL_TRANSITION",
      quadrant_outcome: payload.quadrant_outcome || "IRON_RULE",
      title: payload.title,
      lesson_text: payload.lesson_text,
      is_pinned: payload.is_pinned ?? true,
      is_active: payload.is_active ?? true,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Create rule failed (${res.status})`);
  }
  return res.json();
}

export async function updatePlaybookRule(
  memoryId: number,
  payload: {
    title?: string;
    lesson_text?: string;
    regime_label?: string;
    is_pinned?: boolean;
    is_active?: boolean;
  }
): Promise<{ status: string; memory: EpisodicMemoryRecord }> {
  const res = await fetch(`${API_BASE}/api/memories/playbook/${memoryId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...getWorkspaceHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Update rule failed (${res.status})`);
  }
  return res.json();
}

export async function deletePlaybookRule(memoryId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/memories/playbook/${memoryId}`, {
    method: "DELETE",
    headers: getWorkspaceHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Delete rule failed (${res.status})`);
  }
}

export async function proposeTradeBatch(payload: {
  items: {
    symbol: string;
    side?: "buy" | "sell";
    proposed_qty: number;
    entry_price?: number | null;
    rationale?: string;
  }[];
  risk_budget_pct?: number;
  source_label?: string;
}): Promise<BatchTradeProposalResponse> {
  const res = await fetch(`${API_BASE}/api/trade/propose-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getByokHeaders(), ...getBrokerHeaders() },
    body: JSON.stringify({
      items: payload.items,
      risk_budget_pct: payload.risk_budget_pct ?? 1.0,
      source_label: payload.source_label ?? "自选组合仓位推演仪批量拆单",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Batch propose failed (${res.status})`);
  }
  return res.json();
}

export interface ImportedHoldingItem {
  id: number;
  source_label: string;
  symbol: string;
  side: string;
  qty: number;
  avg_cost_price: number | null;
  currency: string;
  updated_at: string;
}

export async function testUnifiedBrokerConnection(payload: {
  provider: string;
  api_key?: string;
  api_secret?: string;
  env?: string;
  flex_token?: string;
  query_id?: string;
}): Promise<{ ok: boolean; provider: string; message?: string; currency?: string; equity?: number; positions_count?: number }> {
  const res = await fetch(`${API_BASE}/api/trade/broker/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getBrokerHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Broker test failed (${res.status})`);
  }
  return res.json();
}

export async function fetchImportedHoldings(): Promise<{
  workspace_id: string;
  count: number;
  holdings: ImportedHoldingItem[];
}> {
  const res = await fetch(`${API_BASE}/api/trade/broker/imported-holdings`, {
    cache: "no-store",
    headers: getWorkspaceHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Fetch imported holdings failed (${res.status})`);
  }
  return res.json();
}

export async function importBrokerHoldings(payload: {
  raw_text: string;
  source_label?: string;
  replace_existing?: boolean;
}): Promise<{ status: string; workspace_id: string; imported_count: number; symbols: string[] }> {
  const res = await fetch(`${API_BASE}/api/trade/broker/import-holdings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getWorkspaceHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Import holdings failed (${res.status})`);
  }
  return res.json();
}

export async function deleteImportedHolding(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/trade/broker/imported-holdings/${id}`, {
    method: "DELETE",
    headers: getWorkspaceHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Delete imported holding failed (${res.status})`);
  }
}

export async function clearImportedHoldings(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/trade/broker/imported-holdings`, {
    method: "DELETE",
    headers: getWorkspaceHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Clear imported holdings failed (${res.status})`);
  }
}

export interface MocDayPoint {
  date: string;
  label: string;
  tail_window_et: string;
  is_half_day: boolean;
  close_price: number;
  total_volume: number;
  tail_volume: number;
  tail_share_pct: number;
  tail_return_pct: number;
  direction: "up" | "down" | "flat";
}

export interface MocRebalanceWindow {
  title_zh: string;
  tag_zh: string;
  date: string;
  days_away: number;
  impact: "high" | "medium";
}

export interface MocAuctionResponse {
  status: "ok" | "unavailable" | "unsupported";
  symbol: string;
  reason?: string;
  intraday_status?: string;
  intraday_status_zh?: string;
  latest?: MocDayPoint | null;
  baseline_avg_tail_pct?: number | null;
  alert_threshold_pct?: number | null;
  surge_ratio?: number | null;
  signal_tone?: "bullish" | "bearish" | "warning" | "neutral";
  headline_zh?: string;
  impulse_label_zh?: string;
  next_rebalance?: MocRebalanceWindow | null;
  series_10d: MocDayPoint[];
  methodology_note_zh?: string;
  is_stale?: boolean;
  fetched_at?: string;
}

export interface DarkPoolDayPoint {
  date: string;
  label: string;
  close: number | null;
  consolidated_volume: number | null;
  trf_total_volume: number;
  short_volume: number;
  short_exempt_volume: number;
  off_exchange_pct: number | null;
  short_ratio_pct: number;
}

export interface DarkPoolLatestSummary extends DarkPoolDayPoint {
  avg_off_exchange_20d: number | null;
  off_exchange_diff_pp: number | null;
  avg_short_ratio_20d: number | null;
  short_ratio_z: number;
  ret_5d_pct: number | null;
}

export interface FinraAtsWeekRow {
  week_start_date: string;
  last_reported_date: string | null;
  last_update_date: string | null;
  total_shares: number;
  total_notional_usd: number | null;
  total_trades: number | null;
  avg_trade_usd: number | null;
  tier: string | null;
}

export interface DarkPoolProfileResponse {
  status: "ok" | "unavailable" | "unsupported";
  symbol: string;
  reason?: string;
  latest_date?: string;
  latest?: DarkPoolLatestSummary | null;
  signal_tone?: "bullish" | "bearish" | "warning" | "neutral";
  headline_zh?: string;
  series_20d: DarkPoolDayPoint[];
  ats_weekly: {
    weeks: FinraAtsWeekRow[];
    latest: FinraAtsWeekRow | null;
  };
  methodology_note_zh?: string;
}

export interface StablecoinBreakdownItem {
  symbol: string;
  name: string;
  circulating_b: number;
  delta_7d_b: number;
  delta_30d_b: number;
}

export interface StablecoinSeriesPoint {
  date: string;
  label: string;
  total_b: number;
}

export interface BtcChainPoint {
  date: string;
  label: string;
  price_usd: number | null;
  mvrv: number | null;
  flow_in_m: number | null;
  flow_out_m: number | null;
  netflow_m: number | null;
  exchange_reserve_btc: number | null;
  active_addresses: number | null;
  tx_count: number | null;
}

export interface PerpSeriesPoint {
  date: string;
  label: string;
  oi_usd_b?: number;
  oi_btc?: number | null;
  taker_buy_sell_ratio?: number;
  funding_pct?: number;
}

export interface OnChainPulseResponse {
  status: "ok" | "partial" | "unavailable";
  signal_tone?: "bullish" | "bearish" | "warning" | "neutral";
  headline_zh?: string;
  stablecoins: {
    total_circulating_b: number;
    delta_7d_b: number;
    delta_30d_b: number;
    delta_7d_pct: number;
    breakdown: StablecoinBreakdownItem[];
    series_35d: StablecoinSeriesPoint[];
  } | null;
  btc_chain: {
    latest: BtcChainPoint | null;
    netflow_7d_m: number | null;
    mvrv_meta: {
      zone: string;
      label_zh: string;
      hint_zh: string;
    };
    series_35d: BtcChainPoint[];
  } | null;
  perp: {
    symbol: string;
    mark_price: number | null;
    funding_rate_pct: number | null;
    funding_apr_pct: number | null;
    leverage_label_zh: string;
    open_interest_usd_b: number | null;
    open_interest_btc: number | null;
    taker_buy_sell_ratio: number | null;
    top_trader_long_pct: number | null;
    series_30d: PerpSeriesPoint[];
  } | null;
  degraded_sources?: string[];
  methodology_note_zh?: string;
  is_stale?: boolean;
  fetched_at?: string;
}

export async function fetchMocAuction(
  symbol = "SPY",
  forceRefresh = false
): Promise<MocAuctionResponse> {
  const sym = encodeURIComponent(symbol.toUpperCase().trim() || "SPY");
  const res = await fetch(
    `${API_BASE}/api/market/moc?symbol=${sym}&force_refresh=${forceRefresh ? "true" : "false"}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`MOC proxy fetch failed (${res.status})`);
  }
  return res.json();
}

export async function fetchDarkPoolProfile(
  symbol = "SPY",
  forceRefresh = false
): Promise<DarkPoolProfileResponse> {
  const sym = encodeURIComponent(symbol.toUpperCase().trim() || "SPY");
  const res = await fetch(
    `${API_BASE}/api/market/darkpool?symbol=${sym}&force_refresh=${forceRefresh ? "true" : "false"}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Dark pool fetch failed (${res.status})`);
  }
  return res.json();
}

export async function fetchOnChainPulse(
  forceRefresh = false
): Promise<OnChainPulseResponse> {
  const res = await fetch(
    `${API_BASE}/api/market/onchain?force_refresh=${forceRefresh ? "true" : "false"}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`On-chain pulse fetch failed (${res.status})`);
  }
  return res.json();
}

export interface DataPlatformTableEntry {
  table: string;
  title_zh: string;
  layer: "ODS" | "DWD" | "DWS" | "ADS" | string;
  desc_zh: string;
  row_count: number;
  distinct_entities: number | null;
  min_ts: string | null;
  max_ts: string | null;
  lag_hours: number | null;
  sla_hours: number | null;
  sla_status: "healthy" | "warn" | "stale" | "empty" | "error";
}

export interface DataQualityCheckItem {
  id: string;
  name_zh: string;
  table: string;
  status: "pass" | "warn" | "fail";
  detail_zh: string;
  affected: string[];
}

export interface DataPlatformQualityReport {
  checked_at: string;
  health_score: number;
  summary: {
    total: number;
    pass: number;
    warn: number;
    fail: number;
  };
  checks: DataQualityCheckItem[];
}

export interface LineageNode {
  id: string;
  layer: "ods" | "dwd" | "dws" | "ads";
  label: string;
  sub: string;
  status: "healthy" | "warn" | "degraded" | "circuit_open" | "unconfigured" | "empty" | string;
  metric: string;
}

export interface LineageEdge {
  from: string;
  to: string;
}

export interface RedisEnvelopeSnapshot {
  key: string;
  label_zh: string;
  domain: string;
  status: "fresh" | "stale_grace" | "empty";
  fetched_at: string | null;
  age_minutes: number | null;
  soft_ttl_remaining_s: number | null;
  source: string | null;
}

export interface ProviderCircuitItem {
  id: string;
  name: string;
  domain: string;
  auth_mode: string;
  configured: boolean;
  circuit_state: "closed" | "open";
  recent_failures: number;
  cooldown_remaining_s: number | null;
}

export interface FinOpsTelemetry {
  llm_routing: {
    fast_model: string;
    fast_configured: boolean;
    pro_model: string;
    pro_configured: boolean;
    embedding_model: string;
    embedding_dim: number;
    max_steps_guard: number;
    wall_timeout_s: number;
    max_context_tokens: number;
  };
  agent_runtime: {
    recent_threads_sampled: number;
    total_tool_calls: number;
    avg_tools_per_thread: number;
    blocked_duplicate_loops: number;
    per_tool_latency: Array<{
      tool: string;
      calls: number;
      errors: number;
      avg_ms: number;
      p95_ms: number;
    }>;
  };
  cache_efficiency: {
    redis_keys: number;
    redis_memory: string;
    fresh_envelopes: number;
    stale_grace_envelopes: number;
  };
}

export interface PlatformAccessMode {
  requires_admin_token: boolean;
  admin_configured: boolean;
  public_showcase_readonly: boolean;
  app_env: string;
  allow_server_llm_fallback: boolean;
}

export interface DataPlatformOverviewResponse {
  status: string;
  generated_at: string;
  access_mode?: PlatformAccessMode;
  kpis: {
    total_tables: number;
    healthy_tables: number;
    total_pg_rows: number;
    redis_keys: number;
    open_circuit_breakers: number;
    fresh_envelopes: number;
    stale_envelopes: number;
    dq_health_score: number;
    phoenix_ui_url: string | null;
  };
  catalog: DataPlatformTableEntry[];
  quality: DataPlatformQualityReport;
  lineage: {
    nodes: LineageNode[];
    edges: LineageEdge[];
  };
  cache_and_circuits: {
    total_keys: number;
    used_memory_human: string;
    namespace_counts: Array<{ prefix: string; count: number }>;
    envelopes: RedisEnvelopeSnapshot[];
    fresh_envelopes: number;
    stale_envelopes: number;
    providers: ProviderCircuitItem[];
    open_circuit_breakers: number;
  };
  finops: FinOpsTelemetry;
}

export interface SecFilingCorpusRow {
  id: number;
  symbol: string;
  form_type: string;
  filing_date: string;
  chunk_count: number;
  embedded_count: number;
  embedding_pct: number;
  avg_tokens: number;
  ingested_at: string;
}

export interface DataPlatformRagResponse {
  status: string;
  sec_corpus: {
    total_filings: number;
    total_chunks: number;
    embedded_chunks: number;
    embedding_coverage_pct: number;
    filings: SecFilingCorpusRow[];
    top_sections: Array<{ section: string; count: number }>;
  };
  episodic_memory: {
    total: number;
    active: number;
    pinned: number;
    embedded: number;
    quadrants: Array<{ quadrant: string; count: number }>;
    recent: Array<{
      id: number;
      symbol: string;
      regime_label: string;
      quadrant_outcome: string;
      title: string;
      is_pinned: boolean;
      is_active: boolean;
      alpha_vs_spy_pct: number | null;
    }>;
  };
}

export interface RagDebugChunk {
  chunk_id: number;
  symbol: string;
  form_type: string;
  filing_date: string;
  section_title: string;
  chunk_index: number;
  content: string;
  rrf_score: number;
  lexical_rank: number | null;
  vector_rank: number | null;
}

export interface RagDebugResponse {
  status: string;
  elapsed_ms: number;
  symbol: string;
  query: string;
  chunks: RagDebugChunk[];
  ingested_docs?: Array<Record<string, unknown>>;
}

function buildDataPlatformHeaders(
  adminToken?: string | null,
  withJson = false
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (withJson) {
    headers["Content-Type"] = "application/json";
  }
  if (adminToken && adminToken.trim()) {
    headers["X-Admin-Token"] = adminToken.trim();
  }
  return headers;
}

export async function verifyDataPlatformAdminToken(
  adminToken?: string | null
): Promise<PlatformAccessMode & { status: string; unlocked: boolean }> {
  const res = await fetch(`${API_BASE}/api/dataplatform/admin/verify`, {
    method: "POST",
    headers: buildDataPlatformHeaders(adminToken, false),
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Admin unlock failed (${res.status})`);
  }
  return res.json();
}

export async function fetchDataPlatformOverview(): Promise<DataPlatformOverviewResponse> {
  const res = await fetch(`${API_BASE}/api/dataplatform/overview`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Data platform overview failed (${res.status})`);
  }
  return res.json();
}

export async function runDataQualityAudit(
  adminToken?: string | null
): Promise<DataPlatformQualityReport & { status: string }> {
  const res = await fetch(`${API_BASE}/api/dataplatform/quality/run`, {
    method: "POST",
    headers: buildDataPlatformHeaders(adminToken, false),
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Data quality audit failed (${res.status})`);
  }
  return res.json();
}

export async function fetchDataPlatformRagGovernance(): Promise<DataPlatformRagResponse> {
  const res = await fetch(`${API_BASE}/api/dataplatform/rag-governance`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`RAG governance fetch failed (${res.status})`);
  }
  return res.json();
}

export async function debugHybridRagSearch(
  payload: {
    symbol: string;
    query: string;
    form_type?: string | null;
    top_k?: number;
    allow_ingest?: boolean;
  },
  adminToken?: string | null
): Promise<RagDebugResponse> {
  const res = await fetch(`${API_BASE}/api/dataplatform/rag-debug`, {
    method: "POST",
    headers: buildDataPlatformHeaders(adminToken, true),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `RAG debug failed (${res.status})`);
  }
  return res.json();
}

export async function resetProviderCircuit(
  provider: string,
  adminToken?: string | null
): Promise<{ status: string; provider: string; keys_cleared: number }> {
  const res = await fetch(
    `${API_BASE}/api/dataplatform/circuits/${encodeURIComponent(provider)}/reset`,
    {
      method: "POST",
      headers: buildDataPlatformHeaders(adminToken, false),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Reset circuit failed (${res.status})`);
  }
  return res.json();
}

export async function syncDataPlatformDomain(
  domain: "macro" | "equities_gex" | "calendars_cot" | "discover_news" | "full",
  forceRefresh = false,
  adminToken?: string | null
): Promise<{ status: string; domain: string; elapsed_ms: number; detail: Record<string, unknown> }> {
  const res = await fetch(`${API_BASE}/api/dataplatform/sync-domain`, {
    method: "POST",
    headers: buildDataPlatformHeaders(adminToken, true),
    body: JSON.stringify({ domain, force_refresh: forceRefresh }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Domain sync failed (${res.status})`);
  }
  return res.json();
}
export interface EvalTrackSummary {
  id: "track1" | "track2" | "track3" | "track4" | string;
  title_zh: string;
  subtitle: string;
  total: number;
  passed: number;
  pass_rate_pct: number;
  duration_ms: number;
  metrics: Record<string, unknown>;
}

export interface EvalCaseItem {
  id: string;
  track: string;
  category: string;
  name: string;
  passed: boolean;
  elapsed_ms: number;
  observed: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}

export interface EvalRunDiff {
  candidate_run_key: string | null;
  baseline_run_key: string | null;
  candidate_pass_rate_pct: number;
  baseline_pass_rate_pct: number;
  overall_delta_pct: number;
  duration_delta_ms: number;
  regression_detected: boolean;
  newly_regressed: Array<{
    id: string;
    track: string;
    name: string;
    baseline_observed?: unknown;
    candidate_observed?: unknown;
  }>;
  newly_fixed: Array<{
    id: string;
    track: string;
    name: string;
  }>;
  unchanged_fail: Array<{
    id: string;
    track: string;
    name: string;
  }>;
  track_deltas: Record<
    string,
    {
      title_zh: string;
      baseline_pct: number;
      candidate_pct: number;
      delta_pct: number;
    }
  >;
}

export interface MultiTrackEvalReport {
  run_key: string;
  suite_version: string;
  status: string;
  generated_at: string;
  trigger_source: string;
  git_sha: string;
  llm_judge_mode: string;
  pass_k_trials: number;
  tracks_executed: string[];
  total_cases: number;
  passed_cases: number;
  pass_rate_pct: number;
  duration_ms: number;
  tracks: Record<string, EvalTrackSummary>;
  categories: Record<string, { total: number; passed: number; pass_rate_pct: number; track?: string }>;
  results: EvalCaseItem[];
  notes: string;
  is_baseline: boolean;
  persisted?: boolean;
  baseline_diff?: EvalRunDiff | null;
}

export interface EvalRunSummaryRow {
  id: number;
  run_key: string;
  suite_version: string;
  trigger_source: string;
  tracks_executed: string[];
  llm_judge_mode: string;
  git_sha: string;
  pass_k_trials: number;
  total_cases: number;
  passed_cases: number;
  pass_rate_pct: number;
  track_summary: Record<string, EvalTrackSummary>;
  duration_ms: number;
  is_baseline: boolean;
  notes: string;
  created_at: string;
}

export interface EvalRunsListResponse {
  status: string;
  runs: EvalRunSummaryRow[];
  baseline_run_key: string | null;
  latest_report: MultiTrackEvalReport | null;
  baseline_diff: EvalRunDiff | null;
}

export async function fetchDataPlatformEvalRuns(limit = 15): Promise<EvalRunsListResponse> {
  const res = await fetch(`${API_BASE}/api/dataplatform/evals/runs?limit=${limit}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Eval runs fetch failed (${res.status})`);
  }
  return res.json();
}

export async function fetchDataPlatformEvalRunDetail(
  runKey: string
): Promise<EvalRunSummaryRow & { status: string; report: MultiTrackEvalReport }> {
  const res = await fetch(
    `${API_BASE}/api/dataplatform/evals/runs/${encodeURIComponent(runKey)}`,
    { cache: "no-store" }
  );
  if (!res.ok) {
    throw new Error(`Eval run detail failed (${res.status})`);
  }
  return res.json();
}

export async function runDataPlatformEvalSuite(
  payload: {
    tracks?: string[];
    pass_k_trials?: number;
    use_live_judge?: boolean;
    mark_baseline?: boolean;
    notes?: string;
  },
  adminToken?: string | null
): Promise<MultiTrackEvalReport> {
  const res = await fetch(`${API_BASE}/api/dataplatform/evals/run`, {
    method: "POST",
    headers: buildDataPlatformHeaders(adminToken, true),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Run 4-Track evals failed (${res.status})`);
  }
  return res.json();
}

export async function pinDataPlatformEvalBaseline(
  runKey: string,
  adminToken?: string | null
): Promise<{ status: string; baseline: EvalRunSummaryRow }> {
  const res = await fetch(
    `${API_BASE}/api/dataplatform/evals/runs/${encodeURIComponent(runKey)}/baseline`,
    {
      method: "POST",
      headers: buildDataPlatformHeaders(adminToken, false),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Pin baseline failed (${res.status})`);
  }
  return res.json();
}

export async function compareDataPlatformEvalRuns(
  candidate: string,
  baseline: string
): Promise<{ status: string; diff: EvalRunDiff }> {
  const params = new URLSearchParams({ candidate, baseline });
  const res = await fetch(`${API_BASE}/api/dataplatform/evals/compare?${params.toString()}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Compare eval runs failed (${res.status})`);
  }
  return res.json();
}
