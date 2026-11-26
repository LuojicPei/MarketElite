export type LlmProviderId =
  | "deepseek"
  | "gemini"
  | "openai"
  | "siliconflow"
  | "openrouter"
  | "custom";

export interface LlmProviderPreset {
  id: LlmProviderId;
  name: string;
  badge: string;
  baseUrl: string;
  defaultProModel: string;
  defaultFastModel: string;
  suggestedModels: string[];
  helperHint: string;
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek 官方",
    badge: "中文推荐",
    baseUrl: "https://api.deepseek.com/v1",
    defaultProModel: "deepseek-v4-pro",
    defaultFastModel: "deepseek-flash",
    suggestedModels: ["deepseek-v4-pro", "deepseek-flash", "deepseek/deepseek-v4.1-flash"],
    helperHint:
      "支持最新 DeepSeek V4 系列推理与快响应模型，国内直连稳定；填好 Key 后也可点下方「拉取可用模型」查看全部。",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    badge: "Gemini 4",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultProModel: "gemini-4-carbon",
    defaultFastModel: "gemini-3.8-flash",
    suggestedModels: [
      "gemini-4-carbon",
      "gemini-4-neon",
      "gemini-4-hydrogen",
      "gemini-4-argon",
      "gemini-3.8-flash",
      "gemini-3.5-flash",
    ],
    helperHint:
      "覆盖最新 Gemini 4 与 3.8 系列（2.5 已退役）；填入 Google AI Key 后点下方「拉取可用模型」可实时同步您账号下的全量新模型。",
  },
  {
    id: "openai",
    name: "OpenAI 官方",
    badge: "GPT-6",
    baseUrl: "https://api.openai.com/v1",
    defaultProModel: "gpt-6.2-astra",
    defaultFastModel: "gpt-6.2-sol",
    suggestedModels: ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna"],
    helperHint: "覆盖 GPT-6 系列旗舰推理与高性价比模型；支持一键拉取实时模型列表。",
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    badge: "国内聚合",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultProModel: "deepseek-ai/DeepSeek-V4-Pro",
    defaultFastModel: "deepseek-ai/DeepSeek-V4-Flash",
    suggestedModels: [
      "deepseek-ai/DeepSeek-V4-Pro",
      "deepseek-ai/DeepSeek-V4-Flash",
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "Qwen/Qwen3-32B",
    ],
    helperHint: "一个 Key 可直接调用 DeepSeek-V4 与 Qwen3 系列模型，国内直连免折腾，也可点下方拉取实时模型库。",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    badge: "多模型网关",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultProModel: "anthropic/claude-fable-5.2",
    defaultFastModel: "google/gemini-4-neon",
    suggestedModels: [
      "google/gemini-4-neon",
      "google/gemini-4-hydrogen",
      "anthropic/claude-fable-5.2",
      "anthropic/claude-haiku-5.5",
      "openai/gpt-6.2-astra",
      "deepseek/deepseek-v4-pro",
    ],
    helperHint: "聚合 Gemini 4 / Claude 5.x / GPT-6 / DeepSeek V4 全家族；强烈建议填 Key 后直接拉取全量列表。",
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容",
    badge: "自填网关",
    baseUrl: "https://api.openai.com/v1",
    defaultProModel: "gpt-6.2-sol",
    defaultFastModel: "gpt-6-luna",
    suggestedModels: [],
    helperHint: "填写任意符合 OpenAI Chat Completions 协议的中转或私有部署 Base URL，支持直接拉取模型列表。",
  },
];

export type BrokerProviderId =
  | "sandbox"
  | "trading212"
  | "ibkr"
  | "binance"
  | "csv_import"
  | "alpaca";
export type Trading212Env = "live" | "demo";
export type BinanceEnv = "global" | "us" | "testnet";

export interface MarketEliteClientSettings {
  provider: LlmProviderId;
  apiKey: string;
  baseUrl: string;
  proModel: string;
  fastModel: string;
  newsDefaultBilingual: boolean;
  workspaceId: string;
  brokerProvider: BrokerProviderId;
  trading212Env: Trading212Env;
  trading212ApiKey: string;
  trading212ApiSecret: string;
  ibkrFlexToken: string;
  ibkrQueryId: string;
  binanceEnv: BinanceEnv;
  binanceApiKey: string;
  binanceApiSecret: string;
}

const STORAGE_KEY = "marketelite_client_settings_v1";
export const SETTINGS_UPDATED_EVENT = "marketelite:settings-updated";

const LEGACY_RETIRED_DEFAULT_MODELS = new Set([
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "deepseek-reasoner",
  "deepseek-chat",
  "gpt-4o",
  "gpt-4o-mini",
]);

export function getPresetById(id: LlmProviderId): LlmProviderPreset {
  return (
    LLM_PROVIDER_PRESETS.find((item) => item.id === id) ?? LLM_PROVIDER_PRESETS[0]
  );
}

const VALID_BROKERS = new Set<BrokerProviderId>([
  "sandbox",
  "trading212",
  "ibkr",
  "binance",
  "csv_import",
  "alpaca",
]);

function defaultWorkspaceIdForHost(): string {
  if (typeof window === "undefined") return "default";
  const host = (window.location.hostname || "").toLowerCase();
  if (!host || host === "localhost" || host === "127.0.0.1") {
    return "default";
  }
  const rnd =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `ws-${rnd}`;
}

export function getDefaultClientSettings(): MarketEliteClientSettings {
  const preset = getPresetById("deepseek");
  return {
    provider: preset.id,
    apiKey: "",
    baseUrl: preset.baseUrl,
    proModel: preset.defaultProModel,
    fastModel: preset.defaultFastModel,
    newsDefaultBilingual: false,
    workspaceId: defaultWorkspaceIdForHost(),
    brokerProvider: "sandbox",
    trading212Env: "live",
    trading212ApiKey: "",
    trading212ApiSecret: "",
    ibkrFlexToken: "",
    ibkrQueryId: "",
    binanceEnv: "global",
    binanceApiKey: "",
    binanceApiSecret: "",
  };
}

export function loadClientSettings(): MarketEliteClientSettings {
  const defaults = getDefaultClientSettings();
  if (typeof window === "undefined") {
    return defaults;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<MarketEliteClientSettings>;
    const providerValid = LLM_PROVIDER_PRESETS.some((p) => p.id === parsed.provider);
    const provider: LlmProviderId = providerValid
      ? (parsed.provider as LlmProviderId)
      : defaults.provider;
    const preset = getPresetById(provider);
    const savedKey = typeof parsed.apiKey === "string" ? parsed.apiKey : "";
    const resolveModel = (rawVal: unknown, fallback: string) => {
      if (typeof rawVal !== "string" || !rawVal.trim()) return fallback;
      const trimmed = rawVal.trim();
      if (!savedKey.trim() && LEGACY_RETIRED_DEFAULT_MODELS.has(trimmed)) {
        return fallback;
      }
      if (trimmed === "gemini-2.5-pro" || trimmed === "gemini-2.5-flash") {
        return fallback;
      }
      return trimmed;
    };
    const brokerRaw = parsed.brokerProvider as BrokerProviderId;
    const brokerProvider: BrokerProviderId = VALID_BROKERS.has(brokerRaw)
      ? brokerRaw
      : defaults.brokerProvider;
    const trading212Env: Trading212Env =
      parsed.trading212Env === "demo" ? "demo" : "live";
    const binanceEnv: BinanceEnv =
      parsed.binanceEnv === "us" || parsed.binanceEnv === "testnet"
        ? parsed.binanceEnv
        : "global";
    const workspaceId =
      typeof parsed.workspaceId === "string" && parsed.workspaceId.trim()
        ? parsed.workspaceId.trim().slice(0, 48)
        : defaults.workspaceId;
    return {
      provider,
      apiKey: savedKey,
      baseUrl:
        typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
          ? parsed.baseUrl.trim()
          : preset.baseUrl,
      proModel: resolveModel(parsed.proModel, preset.defaultProModel),
      fastModel: resolveModel(parsed.fastModel, preset.defaultFastModel),
      newsDefaultBilingual: Boolean(parsed.newsDefaultBilingual),
      workspaceId,
      brokerProvider,
      trading212Env,
      trading212ApiKey:
        typeof parsed.trading212ApiKey === "string" ? parsed.trading212ApiKey : "",
      trading212ApiSecret:
        typeof parsed.trading212ApiSecret === "string" ? parsed.trading212ApiSecret : "",
      ibkrFlexToken:
        typeof parsed.ibkrFlexToken === "string" ? parsed.ibkrFlexToken : "",
      ibkrQueryId:
        typeof parsed.ibkrQueryId === "string" ? parsed.ibkrQueryId : "",
      binanceEnv,
      binanceApiKey:
        typeof parsed.binanceApiKey === "string" ? parsed.binanceApiKey : "",
      binanceApiSecret:
        typeof parsed.binanceApiSecret === "string" ? parsed.binanceApiSecret : "",
    };
  } catch {
    return defaults;
  }
}

export function saveClientSettings(next: MarketEliteClientSettings): MarketEliteClientSettings {
  const cleaned: MarketEliteClientSettings = {
    provider: next.provider,
    apiKey: next.apiKey.trim(),
    baseUrl: next.baseUrl.trim() || getPresetById(next.provider).baseUrl,
    proModel: next.proModel.trim() || getPresetById(next.provider).defaultProModel,
    fastModel: next.fastModel.trim() || getPresetById(next.provider).defaultFastModel,
    newsDefaultBilingual: Boolean(next.newsDefaultBilingual),
    workspaceId: (next.workspaceId || defaultWorkspaceIdForHost()).trim().slice(0, 48) || "default",
    brokerProvider: next.brokerProvider || "sandbox",
    trading212Env: next.trading212Env === "demo" ? "demo" : "live",
    trading212ApiKey: (next.trading212ApiKey || "").trim(),
    trading212ApiSecret: (next.trading212ApiSecret || "").trim(),
    ibkrFlexToken: (next.ibkrFlexToken || "").trim(),
    ibkrQueryId: (next.ibkrQueryId || "").trim(),
    binanceEnv:
      next.binanceEnv === "us" || next.binanceEnv === "testnet" ? next.binanceEnv : "global",
    binanceApiKey: (next.binanceApiKey || "").trim(),
    binanceApiSecret: (next.binanceApiSecret || "").trim(),
  };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
      window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, { detail: cleaned }));
    } catch {
      // Ignore storage quota exceptions cleanly
    }
  }
  return cleaned;
}

export function clearLocalApiKey(): MarketEliteClientSettings {
  const current = loadClientSettings();
  return saveClientSettings({ ...current, apiKey: "" });
}

export function clearBrokerCredentials(target?: BrokerProviderId): MarketEliteClientSettings {
  const current = loadClientSettings();
  if (target === "ibkr") {
    return saveClientSettings({
      ...current,
      brokerProvider: "sandbox",
      ibkrFlexToken: "",
      ibkrQueryId: "",
    });
  }
  if (target === "binance") {
    return saveClientSettings({
      ...current,
      brokerProvider: "sandbox",
      binanceApiKey: "",
      binanceApiSecret: "",
    });
  }
  return saveClientSettings({
    ...current,
    brokerProvider: "sandbox",
    trading212ApiKey: "",
    trading212ApiSecret: "",
  });
}

export function clearTrading212Keys(): MarketEliteClientSettings {
  return clearBrokerCredentials("trading212");
}

export function rotateWorkspaceId(): MarketEliteClientSettings {
  const current = loadClientSettings();
  const rnd =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : `${Date.now().toString(36)}`;
  return saveClientSettings({ ...current, workspaceId: `ws-${rnd}` });
}

export function hasLocalByokKey(): boolean {
  return Boolean(loadClientSettings().apiKey.trim());
}

export function hasLocalT212Key(): boolean {
  const cfg = loadClientSettings();
  return Boolean(cfg.trading212ApiKey.trim() && cfg.trading212ApiSecret.trim());
}

export function hasConfiguredBrokerConnector(): boolean {
  const cfg = loadClientSettings();
  if (cfg.brokerProvider === "trading212") {
    return Boolean(cfg.trading212ApiKey.trim() && cfg.trading212ApiSecret.trim());
  }
  if (cfg.brokerProvider === "ibkr") {
    return Boolean(cfg.ibkrFlexToken.trim() && cfg.ibkrQueryId.trim());
  }
  if (cfg.brokerProvider === "binance") {
    return Boolean(cfg.binanceApiKey.trim() && cfg.binanceApiSecret.trim());
  }
  return cfg.brokerProvider !== "sandbox";
}

export function getWorkspaceHeaders(): Record<string, string> {
  const cfg = loadClientSettings();
  return {
    "X-Workspace-Id": (cfg.workspaceId || "default").trim() || "default",
  };
}

export function getBrokerHeaders(): Record<string, string> {
  const cfg = loadClientSettings();
  const headers: Record<string, string> = {
    "X-Workspace-Id": (cfg.workspaceId || "default").trim() || "default",
    "X-Broker-Provider": cfg.brokerProvider || "sandbox",
    "X-T212-Env": cfg.trading212Env || "live",
    "X-T212-Read-Only": "true",
    "X-Binance-Env": cfg.binanceEnv || "global",
  };
  if (cfg.trading212ApiKey.trim()) {
    headers["X-T212-Api-Key"] = cfg.trading212ApiKey.trim();
  }
  if (cfg.trading212ApiSecret.trim()) {
    headers["X-T212-Api-Secret"] = cfg.trading212ApiSecret.trim();
  }
  if (cfg.ibkrFlexToken.trim()) {
    headers["X-IBKR-Flex-Token"] = cfg.ibkrFlexToken.trim();
  }
  if (cfg.ibkrQueryId.trim()) {
    headers["X-IBKR-Query-Id"] = cfg.ibkrQueryId.trim();
  }
  if (cfg.binanceApiKey.trim()) {
    headers["X-Binance-Api-Key"] = cfg.binanceApiKey.trim();
  }
  if (cfg.binanceApiSecret.trim()) {
    headers["X-Binance-Api-Secret"] = cfg.binanceApiSecret.trim();
  }
  return headers;
}

export function getByokHeaders(): Record<string, string> {
  const cfg = loadClientSettings();
  const key = cfg.apiKey.trim();
  if (!key) return {};
  const headers: Record<string, string> = {
    "X-LLM-Api-Key": key,
  };
  if (cfg.baseUrl.trim()) {
    headers["X-LLM-Base-Url"] = cfg.baseUrl.trim();
  }
  if (cfg.proModel.trim()) {
    headers["X-LLM-Pro-Model"] = cfg.proModel.trim();
  }
  if (cfg.fastModel.trim()) {
    headers["X-LLM-Fast-Model"] = cfg.fastModel.trim();
  }
  return headers;
}
