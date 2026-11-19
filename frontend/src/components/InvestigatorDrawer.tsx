"use client";

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpRight,
  Bot,
  CheckCircle2,
  FileSearch,
  Loader2,
  Send,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import {
  AgentStatusResponse,
  SecSearchResponse,
  fetchAgentStatus,
  searchSecFilings,
  streamInvestigate,
} from "@/lib/api";

const EASE_EXPO = [0.16, 1, 0.3, 1] as const;

interface ToolTraceItem {
  tool: string;
  status: string;
  latency_ms?: number;
  preview?: string;
}

interface InvestigatorDrawerProps {
  open: boolean;
  onClose: () => void;
  defaultSymbol: string;
}

export default function InvestigatorDrawer({
  open,
  onClose,
  defaultSymbol,
}: InvestigatorDrawerProps) {
  const [tab, setTab] = useState<"agent" | "sec">("agent");
  const [agentStatus, setAgentStatus] = useState<AgentStatusResponse | null>(null);
  const [symbolInput, setSymbolInput] = useState<string>(defaultSymbol);
  const [queryInput, setQueryInput] = useState<string>(
    "Combine current Market Regime, technical momentum, and SEC 10-K/10-Q risk factors."
  );

  // Agent SSE state
  const [runningAgent, setRunningAgent] = useState(false);
  const [nodeStatus, setNodeStatus] = useState<string | null>(null);
  const [toolTraces, setToolTraces] = useState<ToolTraceItem[]>([]);
  const [answer, setAnswer] = useState<string>("");
  const [agentError, setAgentError] = useState<string | null>(null);

  // 0-Token SEC Hybrid RAG state
  const [secQuery, setSecQuery] = useState<string>(
    "risk factors margin compression export controls capital expenditure"
  );
  const [secForm, setSecForm] = useState<string>("");
  const [secLoading, setSecLoading] = useState(false);
  const [secResult, setSecResult] = useState<SecSearchResponse | null>(null);
  const [secError, setSecError] = useState<string | null>(null);

  useEffect(() => {
    setSymbolInput(defaultSymbol);
  }, [defaultSymbol]);

  useEffect(() => {
    if (!open) return;
    fetchAgentStatus()
      .then((status) => {
        setAgentStatus(status);
        if (!status.llm_pro_ready) {
          setTab("sec");
        }
      })
      .catch(() => setAgentStatus(null));
  }, [open]);

  const handleRunAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!queryInput.trim() || runningAgent) return;
    setRunningAgent(true);
    setNodeStatus("Connecting FastMCP + LangGraph...");
    setToolTraces([]);
    setAnswer("");
    setAgentError(null);

    try {
      const threadId = `desk-${symbolInput.toUpperCase()}-${Date.now()}`;
      await streamInvestigate(
        {
          thread_id: threadId,
          query: queryInput.trim(),
          symbol: symbolInput.trim() || null,
          history: [],
        },
        (ev) => {
          if (ev.event === "status") {
            setNodeStatus(String(ev.data.detail ?? ev.data.node ?? "Processing"));
          } else if (ev.event === "tool_result") {
            setToolTraces((prev) => [
              ...prev,
              {
                tool: String(ev.data.tool ?? "tool"),
                status: String(ev.data.status ?? "ok"),
                latency_ms:
                  typeof ev.data.latency_ms === "number" ? ev.data.latency_ms : undefined,
                preview: typeof ev.data.preview === "string" ? ev.data.preview : undefined,
              },
            ]);
          } else if (ev.event === "done") {
            setAnswer(String(ev.data.answer ?? ""));
            setNodeStatus(`Completed (${String(ev.data.steps_taken ?? 0)} steps)`);
          } else if (ev.event === "error") {
            setAgentError(String(ev.data.detail ?? "Agent error"));
          }
        }
      );
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : "Investigation request failed");
    } finally {
      setRunningAgent(false);
    }
  };

  const handleRunSecSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!symbolInput.trim() || !secQuery.trim() || secLoading) return;
    setSecLoading(true);
    setSecError(null);
    try {
      const res = await searchSecFilings({
        symbol: symbolInput.trim().toUpperCase(),
        query: secQuery.trim(),
        form_type: secForm || null,
        top_k: 5,
      });
      setSecResult(res);
    } catch (err) {
      setSecError(err instanceof Error ? err.message : "SEC retrieval failed");
    } finally {
      setSecLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-950/45 p-3 backdrop-blur-sm sm:items-center sm:p-6"
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.35, ease: EASE_EXPO }}
            className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-[#0B0B0D] text-zinc-100 shadow-[0_30px_90px_-15px_rgba(0,0,0,0.75)]"
          >
            {/* Header Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900">
                  <Bot className="h-4 w-4 text-zinc-100" />
                </span>
                <div>
                  <h2 className="font-serif text-xl tracking-tight text-white">
                    Investigator &amp; SEC Hybrid RAG
                  </h2>
                  <p className="font-mono text-[10px] text-zinc-400">
                    FastMCP Read-Only ({agentStatus?.mcp_tools.length ?? 4} tools) · pgvector +
                    tsvector RRF · Guarded Anti-Loop
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {agentStatus?.phoenix_ui_url && (
                  <a
                    href={agentStatus.phoenix_ui_url}
                    target="_blank"
                    rel="noreferrer"
                    className="hidden items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] text-zinc-300 transition hover:border-zinc-500 hover:text-white sm:inline-flex"
                  >
                    Phoenix Trace
                    <ArrowUpRight className="h-3 w-3" />
                  </a>
                )}

                <div className="flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900 p-0.5 font-mono text-[11px]">
                  <button
                    type="button"
                    onClick={() => setTab("agent")}
                    className={`rounded-full px-3 py-1 transition ${
                      tab === "agent" ? "bg-white text-zinc-950" : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    Investigator (SSE)
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab("sec")}
                    className={`rounded-full px-3 py-1 transition ${
                      tab === "sec" ? "bg-white text-zinc-950" : "text-zinc-400 hover:text-white"
                    }`}
                  >
                    SEC RAG (0-Token)
                  </button>
                </div>

                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg border border-zinc-800 p-1.5 text-zinc-400 transition hover:border-zinc-600 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              {tab === "agent" ? (
                <>
                  {agentStatus && !agentStatus.llm_pro_ready && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 font-mono text-xs text-amber-200">
                      <div className="font-semibold">LLM Key Required for Autonomous ReAct</div>
                      <p className="mt-1 text-[11px] text-amber-300/80">
                        Set <code>LLM_PRO_API_KEY</code> and <code>LLM_FAST_API_KEY</code> in{" "}
                        <code>.env</code> to activate Investigator SSE streaming. Meanwhile, switch
                        to <strong>SEC RAG (0-Token)</strong> above to lazy-load live SEC 10-K/10-Q
                        filings immediately.
                      </p>
                    </div>
                  )}

                  <form onSubmit={handleRunAgent} className="space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        value={symbolInput}
                        onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
                        placeholder="Ticker (e.g. NVDA)"
                        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs uppercase text-white placeholder:text-zinc-500 focus:border-zinc-400 focus:outline-none sm:w-32"
                      />
                      <input
                        type="text"
                        value={queryInput}
                        onChange={(e) => setQueryInput(e.target.value)}
                        placeholder="Ask Investigator to correlate macro, GEX walls, and SEC 10-K risks..."
                        className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-sans text-xs text-white placeholder:text-zinc-500 focus:border-zinc-400 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={runningAgent}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-white px-4 py-2 font-mono text-xs font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
                      >
                        {runningAgent ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        Run
                      </button>
                    </div>
                  </form>

                  {nodeStatus && (
                    <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 font-mono text-[11px] text-zinc-300">
                      <Terminal className="h-3.5 w-3.5 text-emerald-400" />
                      <span>{nodeStatus}</span>
                    </div>
                  )}

                  {toolTraces.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                        MCP Tool Execution Trace
                      </div>
                      {toolTraces.map((tr, idx) => (
                        <div
                          key={`${tr.tool}-${idx}`}
                          className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[11px]"
                        >
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5 font-semibold text-zinc-200">
                              <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                              {tr.tool}
                            </span>
                            <span className="text-zinc-500">
                              {tr.status}
                              {tr.latency_ms !== undefined ? ` · ${tr.latency_ms}ms` : ""}
                            </span>
                          </div>
                          {tr.preview && (
                            <p className="mt-1 truncate text-[10px] text-zinc-400">{tr.preview}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {agentError && (
                    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-200">
                      {agentError}
                    </div>
                  )}

                  {answer && (
                    <div className="rounded-2xl border border-zinc-200 bg-white p-5 text-zinc-950">
                      <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                        Investigator Synthesis (Read-Only Grounded)
                      </div>
                      <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">
                        {answer}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <form onSubmit={handleRunSecSearch} className="space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        value={symbolInput}
                        onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
                        placeholder="AAPL"
                        className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs uppercase text-white focus:border-zinc-400 focus:outline-none sm:w-28"
                      />
                      <select
                        value={secForm}
                        onChange={(e) => setSecForm(e.target.value)}
                        className="rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-white focus:border-zinc-400 focus:outline-none sm:w-32"
                      >
                        <option value="">10-K + 10-Q</option>
                        <option value="10-K">10-K Only</option>
                        <option value="10-Q">10-Q Only</option>
                      </select>
                      <input
                        type="text"
                        value={secQuery}
                        onChange={(e) => setSecQuery(e.target.value)}
                        placeholder="Search risk factors, liquidity, margin guidance..."
                        className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 font-sans text-xs text-white focus:border-zinc-400 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={secLoading}
                        className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-white px-4 py-2 font-mono text-xs font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
                      >
                        {secLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FileSearch className="h-3.5 w-3.5" />
                        )}
                        Search Filings
                      </button>
                    </div>
                  </form>

                  {secError && (
                    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 font-mono text-xs text-rose-200">
                      {secError}
                    </div>
                  )}

                  {secResult && (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-zinc-400">
                        <span>
                          Retrieval Mode: <strong className="text-white">{secResult.mode}</strong>
                        </span>
                        <span>
                          Ingested:{" "}
                          {secResult.filings
                            .map((f) => `${f.form_type} (${f.filing_date}, ${f.chunk_count} chunks)`)
                            .join(" · ") || "PostgreSQL Cache"}
                        </span>
                      </div>

                      {secResult.chunks.map((ch) => (
                        <div
                          key={ch.chunk_id}
                          className="rounded-xl border border-zinc-200 bg-white p-4 text-zinc-950"
                        >
                          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
                            <span className="font-semibold text-zinc-900">
                              [{ch.symbol} {ch.form_type} {ch.filing_date}] · {ch.section_title}
                            </span>
                            <span className="text-zinc-500">RRF {ch.rrf_score.toFixed(4)}</span>
                          </div>
                          <p className="text-xs leading-relaxed text-zinc-700">{ch.content}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
