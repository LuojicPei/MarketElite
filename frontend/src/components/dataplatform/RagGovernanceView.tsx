"use client";

import React, { useState } from "react";
import { BookOpen, BrainCircuit, FileSearch, Lock, Sparkles } from "lucide-react";
import {
  DataPlatformRagResponse,
  RagDebugResponse,
  debugHybridRagSearch,
} from "@/lib/api";

interface RagGovernanceViewProps {
  ragData: DataPlatformRagResponse | null;
  loading: boolean;
  isReadOnly?: boolean;
  adminToken?: string;
  onRefresh: () => void;
}

export default function RagGovernanceView({
  ragData,
  loading,
  isReadOnly = false,
  adminToken = "",
  onRefresh,
}: RagGovernanceViewProps) {
  const [symbol, setSymbol] = useState("NVDA");
  const [query, setQuery] = useState("gross margin supply chain export control risk");
  const [allowIngest, setAllowIngest] = useState(false);
  const [searching, setSearching] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [debugResult, setDebugResult] = useState<RagDebugResponse | null>(null);

  const corpus = ragData?.sec_corpus;
  const memory = ragData?.episodic_memory;

  const handleRunDebug = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly || !symbol.trim() || !query.trim()) return;
    setSearching(true);
    setDebugError(null);
    try {
      const res = await debugHybridRagSearch(
        {
          symbol: symbol.trim().toUpperCase(),
          query: query.trim(),
          top_k: 5,
          allow_ingest: allowIngest,
        },
        adminToken
      );
      setDebugResult(res);
      if (allowIngest) {
        onRefresh();
      }
    } catch (err) {
      setDebugError(err instanceof Error ? err.message : "混合检索调试失败");
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* SEC Corpus KPIs + Coverage */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="velvet-white-block rounded-2xl p-5 lg:col-span-7">
          <div className="mb-3 flex items-center justify-between border-b border-zinc-200/80 pb-2.5 dark:border-white/[0.10]">
            <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
              <BookOpen className="h-4 w-4 text-sky-500" />
              <span>SEC 10-K / 10-Q 混合向量语料资产（pgvector + tsvector）</span>
            </div>
            <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              向量完整率 {corpus ? `${corpus.embedding_coverage_pct}%` : loading ? "..." : "—"}
            </span>
          </div>

          <div className="mb-3 grid grid-cols-3 gap-2 font-mono">
            <div className="rounded-xl bg-zinc-100/90 px-3 py-2 dark:bg-white/[0.05]">
              <div className="font-sans text-[10.5px] text-zinc-500 dark:text-zinc-400">
                已入库财报份数
              </div>
              <div className="text-lg font-bold text-zinc-950 dark:text-white">
                {corpus?.total_filings ?? 0} 份
              </div>
            </div>
            <div className="rounded-xl bg-zinc-100/90 px-3 py-2 dark:bg-white/[0.05]">
              <div className="font-sans text-[10.5px] text-zinc-500 dark:text-zinc-400">
                总切片数 (Chunks)
              </div>
              <div className="text-lg font-bold text-zinc-950 dark:text-white">
                {corpus?.total_chunks ?? 0} 块
              </div>
            </div>
            <div className="rounded-xl bg-zinc-100/90 px-3 py-2 dark:bg-white/[0.05]">
              <div className="font-sans text-[10.5px] text-zinc-500 dark:text-zinc-400">
                已向量化切片
              </div>
              <div className="text-lg font-bold text-zinc-950 dark:text-white">
                {corpus?.embedded_chunks ?? 0} 块
              </div>
            </div>
          </div>

          {corpus && corpus.filings.length > 0 ? (
            <div className="max-h-[240px] overflow-y-auto rounded-xl border border-zinc-200/80 dark:border-white/[0.10]">
              <table className="w-full text-left font-mono text-[11px]">
                <thead className="bg-zinc-100/80 text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300">
                  <tr>
                    <th className="px-2.5 py-1.5">代码</th>
                    <th className="px-2.5 py-1.5">报告期</th>
                    <th className="px-2.5 py-1.5 text-right">切片</th>
                    <th className="px-2.5 py-1.5 text-right">向量率</th>
                    <th className="px-2.5 py-1.5 text-right">均Token</th>
                    <th className="px-2.5 py-1.5">快捷调试</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200/70 dark:divide-white/[0.08]">
                  {corpus.filings.map((f) => (
                    <tr key={f.id}>
                      <td className="px-2.5 py-1.5 font-bold">{f.symbol}</td>
                      <td className="px-2.5 py-1.5">
                        {f.form_type} · {f.filing_date}
                      </td>
                      <td className="px-2.5 py-1.5 text-right">{f.chunk_count}</td>
                      <td className="px-2.5 py-1.5 text-right font-semibold text-emerald-600 dark:text-emerald-400">
                        {f.embedding_pct}%
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-zinc-500">
                        {f.avg_tokens}
                      </td>
                      <td className="px-2.5 py-1.5">
                        <button
                          type="button"
                          onClick={() => setSymbol(f.symbol)}
                          className="rounded-full bg-sky-500/15 px-2 py-0.5 font-sans text-[10px] font-semibold text-sky-700 hover:bg-sky-500/25 dark:text-sky-300"
                        >
                          填入调试
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-xl bg-zinc-100/80 p-4 text-center font-sans text-xs text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-400">
              当前尚未按需入库 SEC 10-K/10-Q 财报切片；可在下方沙箱勾选「若无库存自动从 SEC EDGAR 拉取」即时入库一条试测。
            </div>
          )}
        </div>

        {/* Episodic Memory Governance */}
        <div className="velvet-white-block rounded-2xl p-5 lg:col-span-5">
          <div className="mb-3 flex items-center justify-between border-b border-zinc-200/80 pb-2.5 dark:border-white/[0.10]">
            <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
              <BrainCircuit className="h-4 w-4 text-violet-500" />
              <span>Episodic Memory 长期错题与铁律库</span>
            </div>
            <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
              共 {memory?.total ?? 0} 条 · 置顶 {memory?.pinned ?? 0} 条
            </span>
          </div>

          <div className="mb-3 grid grid-cols-3 gap-2 font-mono text-center">
            <div className="rounded-xl bg-zinc-100/90 px-2.5 py-2 dark:bg-white/[0.05]">
              <div className="font-sans text-[10px] text-zinc-500">生效策略</div>
              <div className="text-base font-bold text-zinc-950 dark:text-white">
                {memory?.active ?? 0}
              </div>
            </div>
            <div className="rounded-xl bg-zinc-100/90 px-2.5 py-2 dark:bg-white/[0.05]">
              <div className="font-sans text-[10px] text-zinc-500">已向量化</div>
              <div className="text-base font-bold text-zinc-950 dark:text-white">
                {memory?.embedded ?? 0}
              </div>
            </div>
            <div className="rounded-xl bg-zinc-100/90 px-2.5 py-2 dark:bg-white/[0.05]">
              <div className="font-sans text-[10px] text-zinc-500">象限类型</div>
              <div className="text-base font-bold text-zinc-950 dark:text-white">
                {memory?.quadrants.length ?? 0}
              </div>
            </div>
          </div>

          {memory && memory.recent.length > 0 ? (
            <div className="max-h-[210px] space-y-1.5 overflow-y-auto pr-1">
              {memory.recent.map((m) => (
                <div
                  key={m.id}
                  className="rounded-xl border border-zinc-200/80 bg-white/80 px-3 py-2 text-xs dark:border-white/[0.10] dark:bg-white/[0.04]"
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[10.5px]">
                    <span className="font-bold text-zinc-950 dark:text-white">
                      {m.symbol} · {m.quadrant_outcome}
                    </span>
                    {m.is_pinned && (
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9.5px] font-bold text-amber-800 dark:text-amber-300">
                        PIN 铁律
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-sans text-[11px] text-zinc-700 dark:text-zinc-300">
                    {m.title}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl bg-zinc-100/80 p-4 text-center font-sans text-xs text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-400">
              尚未产生平仓反思或人工 Playbook 规则记忆；在「模拟盘与复盘」平仓反思后会自动沉淀于此。
            </div>
          )}
        </div>
      </div>

      {/* Live Hybrid RAG Retrieval Sandbox */}
      <div className="velvet-white-block rounded-2xl p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 font-sans text-sm font-bold text-zinc-950 dark:text-white">
              <FileSearch className="h-4 w-4 text-emerald-500" />
              <span>Hybrid RAG 混合召回实时调试沙箱（Vector Cosine × BM25 tsvector × RRF 重排）</span>
            </div>
            <p className="mt-0.5 font-sans text-xs text-zinc-600 dark:text-zinc-400">
              直接穿透 Agent 包装层查看底层召回的真实切片、两路排名位次与 RRF 综合评分，用来排查 RAG 漏召回或分段截断。
            </p>
          </div>
        </div>

        <form onSubmit={handleRunDebug} className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="美股代码 如 NVDA"
            className="h-9 w-28 rounded-xl border border-zinc-300 bg-white px-3 font-mono text-xs font-bold uppercase text-zinc-950 focus:border-sky-500 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入 SEC 财报检索词，例如 gross margin capex guidance"
            className="h-9 min-w-[260px] flex-1 rounded-xl border border-zinc-300 bg-white px-3 font-sans text-xs text-zinc-950 focus:border-sky-500 focus:outline-none dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
          />
          <label className="inline-flex cursor-pointer items-center gap-1.5 font-sans text-[11px] text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              disabled={isReadOnly}
              checked={allowIngest}
              onChange={(e) => setAllowIngest(e.target.checked)}
              className="rounded border-zinc-400 disabled:opacity-50"
            />
            无库存时自动从 SEC EDGAR 入库
          </label>
          <button
            type="submit"
            disabled={searching || isReadOnly}
            title={isReadOnly ? "访客只读模式已锁定实时 PG/Embedding 召回与 EDGAR 拉取" : undefined}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-emerald-600 px-4 font-sans text-xs font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isReadOnly ? (
              <Lock className="h-3.5 w-3.5" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {isReadOnly ? "只读锁定 · 需口令调试" : searching ? "检索评分中..." : "执行 Hybrid 召回对比"}
          </button>
        </form>

        {isReadOnly && (
          <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 font-sans text-[11px] text-amber-900 dark:text-amber-200">
            🔒 访客只读模式保护服务器 Embedding 配额与 SEC EDGAR 抓取接口：您可浏览上方已入库财报覆盖度与情景记忆规则，或切换至「全栈评测 (4-Track)」展开 <b>Track 2 RAG-F01~F08</b> 实证结果。
          </div>
        )}

        {debugError && (
          <div className="mt-3 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-800 dark:text-rose-200">
            {debugError}
          </div>
        )}

        {debugResult && (
          <div className="mt-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
              <span>
                命中 {debugResult.chunks.length} 个切片（标的 {debugResult.symbol}）
              </span>
              <span>耗时 {debugResult.elapsed_ms} ms</span>
            </div>
            {debugResult.chunks.length === 0 ? (
              <div className="rounded-xl bg-zinc-100/80 p-4 text-center font-sans text-xs text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-400">
                当前库中暂无 {debugResult.symbol} 匹配切片（若首次调试该股票，可勾选上方“无库存时自动从 SEC EDGAR 入库”后再点执行）。
              </div>
            ) : (
              <div className="space-y-2">
                {debugResult.chunks.map((c, idx) => (
                  <div
                    key={c.chunk_id}
                    className="rounded-xl border border-zinc-200/85 bg-white/85 p-3 dark:border-white/[0.10] dark:bg-white/[0.04]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-mono text-xs font-bold text-zinc-950 dark:text-white">
                        #{idx + 1} · [{c.form_type} {c.filing_date}] {c.section_title}
                      </div>
                      <div className="flex flex-wrap gap-1.5 font-mono text-[10.5px]">
                        <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-sky-800 dark:text-sky-300">
                          Vector Rank: {c.vector_rank != null ? `#${c.vector_rank}` : "未启用/无向量"}
                        </span>
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-800 dark:text-amber-300">
                          BM25 Rank: {c.lexical_rank != null ? `#${c.lexical_rank}` : "未命中"}
                        </span>
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-bold text-emerald-800 dark:text-emerald-300">
                          RRF: {c.rrf_score.toFixed(5)}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1.5 line-clamp-3 font-sans text-[11.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                      {c.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
