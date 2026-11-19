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

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:8000";

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
