"use client";

import React from "react";

interface MarkdownReportProps {
  content: string;
  compact?: boolean;
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match inline code, bold, italic, or SEC/citation bracket tags cleanly
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
          className="rounded border border-[#E2E2DE] bg-[#F5F5F2] px-1.5 py-0.5 font-mono text-[11px] text-[#0B0B0D]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={keyIdx} className="font-semibold text-[#0B0B0D]">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <em key={keyIdx} className="italic text-[#3A3A40]">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith("[") && token.endsWith("]")) {
      nodes.push(
        <span
          key={keyIdx}
          className="mx-0.5 inline-block rounded-full border border-[#D4D4CE] bg-[#F3F3F0] px-2 py-0.5 font-mono text-[10px] font-medium text-[#111113]"
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

export function MarkdownReport({ content, compact = false }: MarkdownReportProps) {
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

    // Fenced code blocks
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

    // Headings
    const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hMatch) {
      const level = hMatch[1].length;
      const titleText = hMatch[2];
      const cls =
        level <= 2
          ? "mt-3 border-b border-[#E7E7E2] pb-1 font-serif text-[16px] font-semibold tracking-tight text-[#0B0B0D]"
          : "mt-2.5 text-[13px] font-semibold tracking-tight text-[#0B0B0D]";
      blocks.push(
        <h4 key={`h-${idx}`} className={cls}>
          {renderInline(titleText)}
        </h4>
      );
      idx += 1;
      continue;
    }

    // Markdown table
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
        <div key={`tbl-${idx}`} className="overflow-x-auto rounded-lg border border-[#E2E2DE]">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead className="bg-[#F5F5F2] text-[10px] uppercase tracking-wider text-[#5F5F67]">
              <tr>
                {headers.map((h, hIdx) => (
                  <th key={hIdx} className="border-b border-[#E2E2DE] px-2.5 py-1.5 font-mono font-medium">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr key={rIdx} className="border-b border-[#EFEFEB] last:border-b-0">
                  {headers.map((_, cIdx) => (
                    <td key={cIdx} className="px-2.5 py-1.5 font-mono text-[11px] text-[#111113]">
                      {renderInline(r[cIdx] || "")}
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

    // Horizontal divider
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`hr-${idx}`} className="my-2 border-[#E7E7E2]" />);
      idx += 1;
      continue;
    }

    // Unordered or ordered list
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
          } ${compact ? "text-[12px]" : "text-[13px]"} leading-relaxed text-[#1A1A1F]`}
        >
          {items.map((item, liIdx) => (
            <li key={liIdx}>{renderInline(item)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (idx < lines.length && lines[idx].trim().startsWith(">")) {
        quoteLines.push(lines[idx].trim().replace(/^>\s?/, ""));
        idx += 1;
      }
      blocks.push(
        <blockquote
          key={`q-${idx}`}
          className="border-l-2 border-[#0B0B0D] bg-[#F5F5F2] px-3 py-2 text-[12px] leading-relaxed text-[#3A3A40]"
        >
          {renderInline(quoteLines.join(" "))}
        </blockquote>
      );
      continue;
    }

    // Paragraph (collect contiguous non-structural lines)
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
        className={`${compact ? "text-[12px]" : "text-[13px]"} leading-relaxed text-[#18181B]`}
      >
        {renderInline(paraLines.join(" "))}
      </p>
    );
  }

  return <div className={compact ? "space-y-1.5" : "space-y-2.5"}>{blocks}</div>;
}
