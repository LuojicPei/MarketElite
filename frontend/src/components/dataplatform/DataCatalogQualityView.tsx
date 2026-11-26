"use client";

import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Lock,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  DataPlatformQualityReport,
  DataPlatformTableEntry,
  syncDataPlatformDomain,
} from "@/lib/api";

interface DataCatalogQualityViewProps {
  catalog: DataPlatformTableEntry[];
  quality: DataPlatformQualityReport | null;
  runningQuality: boolean;
  isReadOnly?: boolean;
  adminToken?: string;
  onRerunQuality: () => void;
  onSyncCompleted: () => void;
}

type LayerFilter = "ALL" | "ODS" | "DWD" | "DWS" | "ADS";

const SYNC_DOMAINS: Array<{
  id: "macro" | "equities_gex" | "calendars_cot" | "discover_news" | "full";
  label: string;
  desc: string;
}> = [
  { id: "macro", label: "同步宏观 + CBOE", desc: "FRED 净活水/利率 + VIX" },
  { id: "equities_gex", label: "同步美股 + 期权 GEX", desc: "SIP 日线 + BTC + SPY/QQQ GEX" },
  { id: "calendars_cot", label: "同步日历 + CFTC", desc: "宏观财报日程 + 机构COT" },
  { id: "discover_news", label: "同步 21 条要闻自愈", desc: "多源财经要闻 + 中译检查" },
  { id: "full", label: "全量全管线同步", desc: "Full Pipeline Bootstrap" },
];

function slaPill(status: DataPlatformTableEntry["sla_status"]): {
  cls: string;
  label: string;
} {
  if (status === "healthy") {
    return {
      cls: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
      label: "SLA 达标",
    };
  }
  if (status === "warn") {
    return {
      cls: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
      label: "临界预警",
    };
  }
  if (status === "stale") {
    return {
      cls: "bg-rose-500/15 text-rose-800 dark:text-rose-300",
      label: "已超SLA",
    };
  }
  if (status === "empty") {
    return {
      cls: "bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-zinc-300",
      label: "空表待填",
    };
  }
  return {
    cls: "bg-rose-500/15 text-rose-800 dark:text-rose-300",
    label: "异常",
  };
}

export default function DataCatalogQualityView({
  catalog,
  quality,
  runningQuality,
  isReadOnly = false,
  adminToken = "",
  onRerunQuality,
  onSyncCompleted,
}: DataCatalogQualityViewProps) {
  const [layerFilter, setLayerFilter] = useState<LayerFilter>("ALL");
  const [forceRefreshSync, setForceRefreshSync] = useState(false);
  const [syncingDomain, setSyncingDomain] = useState<string | null>(null);
  const [syncBanner, setSyncBanner] = useState<{ ok: boolean; msg: string } | null>(
    null
  );

  const filteredTables = useMemo(
    () =>
      catalog.filter((row) =>
        layerFilter === "ALL" ? true : row.layer === layerFilter
      ),
    [catalog, layerFilter]
  );

  const handleTriggerDomainSync = async (
    domain: "macro" | "equities_gex" | "calendars_cot" | "discover_news" | "full"
  ) => {
    if (isReadOnly) return;
    setSyncingDomain(domain);
    setSyncBanner(null);
    try {
      const res = await syncDataPlatformDomain(domain, forceRefreshSync, adminToken);
      setSyncBanner({
        ok: true,
        msg: `[${res.domain}] 同步完成（耗时 ${res.elapsed_ms}ms）：${JSON.stringify(res.detail)}`,
      });
      onSyncCompleted();
    } catch (err) {
      setSyncBanner({
        ok: false,
        msg: err instanceof Error ? err.message : "同步失败",
      });
    } finally {
      setSyncingDomain(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Data Quality Audit Panel */}
      <div className="velvet-white-block rounded-2xl p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 pb-3 dark:border-white/[0.10]">
          <div>
            <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              <span>金融数据质量自动稽核引擎（6 项实库红绿灯检查）</span>
            </div>
            <p className="mt-0.5 font-sans text-xs text-zinc-600 dark:text-zinc-400">
              自动核验日线断档/零成交脏柱、FRED 更新滞后、GEX 空洞、21 条新闻中译完整率与多租户隔离完整性。
            </p>
          </div>

          <div className="flex items-center gap-3">
            {quality && (
              <div className="rounded-xl border border-zinc-200/90 bg-zinc-50 px-3.5 py-1.5 text-right font-mono dark:border-white/15 dark:bg-white/[0.05]">
                <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                  DQ HEALTH SCORE
                </div>
                <div
                  className={`text-lg font-bold ${
                    quality.health_score >= 85
                      ? "text-emerald-600 dark:text-emerald-400"
                      : quality.health_score >= 60
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-rose-600 dark:text-rose-400"
                  }`}
                >
                  {quality.health_score} / 100
                </div>
              </div>
            )}
            <button
              type="button"
              disabled={runningQuality || isReadOnly}
              onClick={onRerunQuality}
              title={isReadOnly ? "访客只读模式已锁定质量重跑，请在顶部解锁管理员口令" : undefined}
              className="inline-flex items-center gap-1.5 rounded-full bg-zinc-950 px-4 py-2 font-mono text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
            >
              {isReadOnly ? (
                <Lock className="h-3.5 w-3.5" />
              ) : (
                <RefreshCw
                  className={`h-3.5 w-3.5 ${runningQuality ? "animate-spin" : ""}`}
                />
              )}
              {isReadOnly
                ? "只读锁定 · 需口令重跑"
                : runningQuality
                  ? "稽核运行中..."
                  : "立即重跑质量稽核"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
          {(quality?.checks ?? []).map((chk) => {
            const Icon =
              chk.status === "pass"
                ? CheckCircle2
                : chk.status === "fail"
                  ? XCircle
                  : AlertTriangle;
            const iconCls =
              chk.status === "pass"
                ? "text-emerald-500"
                : chk.status === "fail"
                  ? "text-rose-500"
                  : "text-amber-500";
            return (
              <div
                key={chk.id}
                className="rounded-xl border border-zinc-200/85 bg-white/85 p-3 dark:border-white/[0.10] dark:bg-white/[0.04]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Icon className={`h-4 w-4 shrink-0 ${iconCls}`} />
                    <span className="font-mono text-[11px] font-bold text-zinc-900 dark:text-zinc-100">
                      {chk.id}
                    </span>
                    <span className="font-sans text-xs font-bold text-zinc-950 dark:text-white">
                      {chk.name_zh}
                    </span>
                  </div>
                </div>
                <p className="mt-1.5 font-sans text-[11.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                  {chk.detail_zh}
                </p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-1 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                  <span>表/源: {chk.table}</span>
                  {chk.affected.length > 0 && (
                    <span className="text-amber-600 dark:text-amber-400">
                      异常项: {chk.affected.slice(0, 4).join(", ")}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Domain Sync Dispatcher */}
      <div className="velvet-white-block rounded-2xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-sans text-xs font-bold text-zinc-950 dark:text-white">
              分域数据管道调度台（对应 ARQ Worker 同步任务）
            </div>
            <div className="font-sans text-[11px] text-zinc-600 dark:text-zinc-400">
              {isReadOnly
                ? "🔒 访客只读保护已开启：需在右上角验证管理员口令后方可触发实时域同步。"
                : "可按业务域定向补数（配置 ADMIN_API_TOKEN 后自动强制校验）。"}
            </div>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              disabled={isReadOnly}
              checked={forceRefreshSync}
              onChange={(e) => setForceRefreshSync(e.target.checked)}
              className="rounded border-zinc-400 disabled:opacity-50"
            />
            强制穿透缓存刷新 (force_refresh)
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {SYNC_DOMAINS.map((dom) => {
            const busy = syncingDomain === dom.id;
            return (
              <button
                key={dom.id}
                type="button"
                disabled={syncingDomain !== null || isReadOnly}
                onClick={() => handleTriggerDomainSync(dom.id)}
                title={isReadOnly ? "访客只读模式已锁定域同步" : dom.desc}
                className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-300/90 bg-white/90 px-3 py-1.5 font-sans text-xs font-semibold text-zinc-900 transition hover:border-sky-500 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/15 dark:bg-white/[0.06] dark:text-zinc-100 dark:hover:border-sky-400"
              >
                {isReadOnly ? (
                  <Lock className="h-3 w-3 text-amber-500" />
                ) : (
                  <Play className={`h-3 w-3 ${busy ? "animate-spin text-sky-500" : "text-emerald-500"}`} />
                )}
                <span>{busy ? "执行中..." : dom.label}</span>
              </button>
            );
          })}
        </div>

        {syncBanner && (
          <div
            className={`mt-2.5 rounded-xl border px-3 py-1.5 font-mono text-[11px] ${
              syncBanner.ok
                ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
                : "border-rose-500/35 bg-rose-500/10 text-rose-900 dark:text-rose-200"
            }`}
          >
            {syncBanner.msg}
          </div>
        )}
      </div>

      {/* PostgreSQL 15-Table Live Asset Catalog */}
      <div className="velvet-white-block rounded-2xl p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
            <Database className="h-4 w-4 text-sky-500" />
            <span>PostgreSQL {catalog.length || 16} 张核心数据资产目录（实表元数据 &amp; SLA）</span>
          </div>

          <div className="flex flex-wrap gap-1 rounded-full border border-zinc-300/80 bg-white/80 p-0.5 font-mono text-[10.5px] dark:border-white/15 dark:bg-white/[0.06]">
            {(["ALL", "ODS", "DWD", "DWS", "ADS"] as const).map((lv) => (
              <button
                key={lv}
                type="button"
                onClick={() => setLayerFilter(lv)}
                className={`rounded-full px-2.5 py-0.5 font-semibold transition ${
                  layerFilter === lv
                    ? "bg-zinc-950 text-white dark:bg-white dark:text-zinc-950"
                    : "text-zinc-600 dark:text-zinc-300"
                }`}
              >
                {lv}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-zinc-200/85 dark:border-white/[0.10]">
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="bg-zinc-100/90 text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300">
              <tr>
                <th className="px-3 py-2">层级</th>
                <th className="px-3 py-2">表名与业务说明</th>
                <th className="px-3 py-2 text-right">精确行数</th>
                <th className="px-3 py-2 text-right">覆盖实体</th>
                <th className="px-3 py-2">时间范围 (最早 ~ 最新)</th>
                <th className="px-3 py-2 text-right">滞后 Lag</th>
                <th className="px-3 py-2">SLA 状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200/75 dark:divide-white/[0.08]">
              {filteredTables.map((row) => {
                const pill = slaPill(row.sla_status);
                return (
                  <tr
                    key={row.table}
                    className="hover:bg-zinc-100/60 dark:hover:bg-white/[0.04]"
                  >
                    <td className="px-3 py-2">
                      <span className="rounded bg-zinc-200/80 px-1.5 py-0.5 text-[10px] font-bold text-zinc-800 dark:bg-white/10 dark:text-zinc-200">
                        {row.layer}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-sans text-xs font-bold text-zinc-950 dark:text-white">
                        {row.title_zh}{" "}
                        <span className="font-mono text-[10px] font-normal text-zinc-500">
                          ({row.table})
                        </span>
                      </div>
                      <div className="font-sans text-[10.5px] text-zinc-600 dark:text-zinc-400">
                        {row.desc_zh}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-zinc-950 dark:text-zinc-100">
                      {row.row_count.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-600 dark:text-zinc-300">
                      {row.distinct_entities != null ? row.distinct_entities : "—"}
                    </td>
                    <td className="px-3 py-2 text-[10.5px] text-zinc-600 dark:text-zinc-300">
                      {row.min_ts && row.max_ts
                        ? `${row.min_ts.slice(0, 10)} ~ ${row.max_ts.slice(0, 10)}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-600 dark:text-zinc-300">
                      {row.lag_hours != null ? `${row.lag_hours}h` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 font-sans text-[10px] font-bold ${pill.cls}`}
                      >
                        {pill.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
