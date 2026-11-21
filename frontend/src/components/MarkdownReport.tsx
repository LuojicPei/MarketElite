"use client";

import React from "react";

interface MarkdownReportProps {
  content: string;
  compact?: boolean;
  surface?: "auto" | "light";
}

function renderInline(text: string, isAuto: boolean): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]{3,80}\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    keyIdx += 1;
    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={keyIdx}
          className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
            isAuto
              ? "border-[#E2E2DE] bg-[#F5F5F2] text-[#0B0B0D] dark:border-white/15 dark:bg-white/[0.07] dark:text-zinc-100"
              : "border-[#E2E2DE] bg-[#F5F5F2] text-[#0B0B0D]"
          }`}
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong
          key={keyIdx}
          className={
            isAuto
              ? "font-semibold text-[#0B0B0D] dark:text-white"
              : "font-semibold text-[#0B0B0D]"
          }
        >
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <em
          key={keyIdx}
          className={isAuto ? "italic text-[#3A3A40] dark:text-zinc-300" : "italic text-[#3A3A40]"}
        >
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith("[") && token.endsWith("]")) {
      nodes.push(
        <span
          key={keyIdx}
          className={`mx-0.5 inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${
            isAuto
              ? "border-[#D4D4CE] bg-[#F3F3F0] text-[#111113] dark:border-white/15 dark:bg-white/[0.08] dark:text-zinc-200"
              : "border-[#D4D4CE] bg-[#F3F3F0] text-[#111113]"
          }`}
        >
          {token.slice(1, -1)}
        </span>
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?$/.test(trimmed);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

export function MarkdownReport({ content, compact = false, surface = "auto" }: MarkdownReportProps) {
  const isAuto = surface === "auto";
  const lines = (content || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (!trimmed) {
      idx += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      idx += 1;
      while (idx < lines.length && !lines[idx].trim().startsWith("```")) {
        codeLines.push(lines[idx]);
        idx += 1;
      }
      idx += 1;
      blocks.push(
        <pre
          key={`code-${idx}`}
          className="overflow-x-auto rounded-lg border border-[#232329] bg-[#111114] p-3 font-mono text-[11px] leading-relaxed text-[#E7E7E2]"
        >
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hMatch) {
      const level = hMatch[1].length;
      const titleText = hMatch[2];
      const cls =
        level <= 2
          ? `mt-3 border-b pb-1 font-serif text-[16px] font-semibold tracking-tight ${
              isAuto
                ? "border-[#E7E7E2] text-[#0B0B0D] dark:border-white/10 dark:text-white"
                : "border-[#E7E7E2] text-[#0B0B0D]"
            }`
          : `mt-2.5 text-[13px] font-semibold tracking-tight ${
              isAuto ? "text-[#0B0B0D] dark:text-white" : "text-[#0B0B0D]"
            }`;
      blocks.push(
        <h4 key={`h-${idx}`} className={cls}>
          {renderInline(titleText, isAuto)}
        </h4>
      );
      idx += 1;
      continue;
    }

    if (
      trimmed.includes("|") &&
      idx + 1 < lines.length &&
      isTableSeparator(lines[idx + 1])
    ) {
      const headers = splitTableRow(trimmed);
      idx += 2;
      const rows: string[][] = [];
      while (idx < lines.length && lines[idx].trim().includes("|")) {
        rows.push(splitTableRow(lines[idx]));
        idx += 1;
      }
      blocks.push(
        <div
          key={`tbl-${idx}`}
          className={`overflow-x-auto rounded-lg border ${
            isAuto ? "border-[#E2E2DE] dark:border-white/10" : "border-[#E2E2DE]"
          }`}
        >
          <table className="w-full border-collapse text-left text-[12px]">
            <thead
              className={`text-[10px] uppercase tracking-wider ${
                isAuto
                  ? "bg-[#F5F5F2] text-[#5F5F67] dark:bg-white/[0.06] dark:text-zinc-400"
                  : "bg-[#F5F5F2] text-[#5F5F67]"
              }`}
            >
              <tr>
                {headers.map((h, hIdx) => (
                  <th
                    key={hIdx}
                    className={`border-b px-2.5 py-1.5 font-mono font-medium ${
                      isAuto ? "border-[#E2E2DE] dark:border-white/10" : "border-[#E2E2DE]"
                    }`}
                  >
                    {renderInline(h, isAuto)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr
                  key={rIdx}
                  className={`border-b last:border-b-0 ${
                    isAuto ? "border-[#EFEFEB] dark:border-white/[0.06]" : "border-[#EFEFEB]"
                  }`}
                >
                  {headers.map((_, cIdx) => (
                    <td
                      key={cIdx}
                      className={`px-2.5 py-1.5 font-mono text-[11px] ${
                        isAuto ? "text-[#111113] dark:text-zinc-200" : "text-[#111113]"
                      }`}
                    >
                      {renderInline(r[cIdx] || "", isAuto)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push(
        <hr
          key={`hr-${idx}`}
          className={`my-2 ${isAuto ? "border-[#E7E7E2] dark:border-white/10" : "border-[#E7E7E2]"}`}
        />
      );
      idx += 1;
      continue;
    }

    if (/^[-*+•]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const isOrdered = /^\d+\.\s+/.test(trimmed);
      const items: string[] = [];
      while (idx < lines.length) {
        const t = lines[idx].trim();
        if (isOrdered && /^\d+\.\s+/.test(t)) {
          items.push(t.replace(/^\d+\.\s+/, ""));
          idx += 1;
        } else if (!isOrdered && /^[-*+•]\s+/.test(t)) {
          items.push(t.replace(/^[-*+•]\s+/, ""));
          idx += 1;
        } else {
          break;
        }
      }
      const ListTag = isOrdered ? "ol" : "ul";
      blocks.push(
        <ListTag
          key={`list-${idx}`}
          className={`space-y-1 pl-4 ${
            isOrdered ? "list-decimal" : "list-disc"
          } ${compact ? "text-[12px]" : "text-[13px]"} leading-relaxed ${
            isAuto ? "text-[#1A1A1F] dark:text-zinc-200" : "text-[#1A1A1F]"
          }`}
        >
          {items.map((item, liIdx) => (
            <li key={liIdx}>{renderInline(item, isAuto)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (idx < lines.length && lines[idx].trim().startsWith(">")) {
        quoteLines.push(lines[idx].trim().replace(/^>\s?/, ""));
        idx += 1;
      }
      blocks.push(
        <blockquote
          key={`q-${idx}`}
          className={`border-l-2 px-3 py-2 text-[12px] leading-relaxed ${
            isAuto
              ? "border-[#0B0B0D] bg-[#F5F5F2] text-[#3A3A40] dark:border-white/40 dark:bg-white/[0.05] dark:text-zinc-300"
              : "border-[#0B0B0D] bg-[#F5F5F2] text-[#3A3A40]"
          }`}
        >
          {renderInline(quoteLines.join(" "), isAuto)}
        </blockquote>
      );
      continue;
    }

    const paraLines: string[] = [trimmed];
    idx += 1;
    while (idx < lines.length) {
      const next = lines[idx].trim();
      if (
        !next ||
        /^(#{1,4}|```|>|[-*+•]\s+|\d+\.\s+|-{3,}|\*{3,})/.test(next) ||
        next.includes("|")
      ) {
        break;
      }
      paraLines.push(next);
      idx += 1;
    }
    blocks.push(
      <p
        key={`p-${idx}`}
        className={`${compact ? "text-[12px]" : "text-[13px]"} leading-relaxed ${
          isAuto ? "text-[#18181B] dark:text-zinc-200" : "text-[#18181B]"
        }`}
      >
        {renderInline(paraLines.join(" "), isAuto)}
      </p>
    );
  }

  return <div className={compact ? "space-y-1.5" : "space-y-2.5"}>{blocks}</div>;
}
