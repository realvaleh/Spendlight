import type { Summary } from "./types.js";
import { fmt } from "./budget.js";

export function receiptMarkdown(summary: Summary): string {
  const scoped = summary.scopeProject != null;
  const lines = [
    `# Spendlight receipt`,
    ``,
    ...(scoped ? [`Project **${summary.scopeProject || "—"}**`, ``] : []),
    `Generated **${summary.generatedAt}**`,
    ``,
    `| | |`,
    `| --- | ---: |`,
    `| Total spend | ${fmt(summary.spendUsd)} |`,
    `| Requests | ${summary.requests} |`,
    `| Tokens | ${summary.tokens.toLocaleString("en-US")} |`,
    `| Budget status | ${statusLabel(summary)} |`,
    ...windowRows(summary),
    ...projectBudgetRows(summary),
    ...globalSpendRow(summary),
    `| Global hard | ${fmt(summary.budget.globalLimit.hardUsd)} |`,
    `| Global soft | ${fmt(summary.budget.globalLimit.softUsd)} |`,
    ``,
    `## By project`,
    ``,
    `| Project | Spend | Requests | Tokens |`,
    `| --- | ---: | ---: | ---: |`,
    ...summary.byProject.map(
      (p) => `| ${p.project} | ${fmt(p.spendUsd)} | ${p.requests} | ${p.tokens.toLocaleString("en-US")} |`,
    ),
    summary.byProject.length === 0 ? `| — | $0 | 0 | 0 |` : ``,
    ``,
    `## By model`,
    ``,
    `| Model | Spend | Requests | Tokens |`,
    `| --- | ---: | ---: | ---: |`,
    ...summary.byModel.map(
      (m) => `| \`${m.model}\` | ${fmt(m.spendUsd)} | ${m.requests} | ${m.tokens.toLocaleString("en-US")} |`,
    ),
    summary.byModel.length === 0 ? `| — | $0 | 0 | 0 |` : ``,
    ``,
    `## Recent requests`,
    ``,
    `| When | Project | Model | Tokens | Cost | Status |`,
    `| --- | --- | --- | ---: | ---: | ---: |`,
    ...summary.recent
      .slice(0, 20)
      .map(
        (r) =>
          `| ${r.createdAt} | ${r.project} | \`${r.model}\` | ${r.totalTokens} | ${fmt(r.costUsd)} | ${r.status} |`,
      ),
    ``,
    `_Logged by [Spendlight](https://github.com/realvaleh/Spendlight). Costs are estimates from the configured price table._`,
    ``,
  ];
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}

export function receiptSvg(summary: Summary): string {
  const rows = summary.byModel.slice(0, 8);
  const rowH = 22;
  const header = 168;
  const tableH = Math.max(rows.length, 1) * rowH;
  const windowLabel = calendarWindowLabel(summary.budget.period);
  const scoped = summary.scopeProject != null;
  const projectName = summary.scopeProject ?? "";
  const projectHard = scoped && projectName ? summary.budget.projectLimit.hardUsd : null;
  const projectSoft = scoped && projectName ? summary.budget.projectLimit.softUsd : null;
  const hardValue = projectHard != null ? projectHard : summary.budget.globalLimit.hardUsd;
  const hardLabel = projectHard != null ? "project hard" : windowLabel ? `hard budget ${windowLabel}` : "hard budget";
  const windowSpend = scoped ? summary.budget.projectSpend : summary.budget.globalSpend;
  const tail: string[] = [];
  if (scoped) {
    const globalLabel = windowLabel ? `global ${windowLabel}` : "global spend";
    tail.push(`${globalLabel} ${fmt(summary.budget.globalSpend)} / ${fmt(summary.budget.globalLimit.hardUsd)}`);
    if (projectSoft != null) tail.push(`project soft ${fmt(projectSoft)}`);
  }
  const extra = (windowLabel ? 22 : 0) + tail.length * 22;
  const height = header + tableH + 150 + extra;
  const total = fmt(summary.spendUsd);
  const hard = fmt(hardValue);
  const status = statusLabel(summary);
  const sub = scoped && projectName ? `spend receipt · ${truncate(projectName, 24)}` : "spend receipt";
  const aria = scoped && projectName ? `Spendlight receipt for ${projectName}` : "Spendlight receipt";
  const tailY0 = header + tableH + 120 + (windowLabel ? 22 : 0);
  const tailSvg = tail
    .map((line, i) => `<text x="48" y="${tailY0 + i * 22}" class="muted">${escapeXml(line)}</text>`)
    .join("\n");
  const modelLines =
    rows.length === 0
      ? `<text x="36" y="${header + 16}" class="muted">No line items yet</text>`
      : rows
          .map((m, i) => {
            const y = header + 16 + i * rowH;
            const name = escapeXml(truncate(m.model, 28));
            return `<text x="36" y="${y}" class="item">${name}</text>
            <text x="444" y="${y}" class="item amount">${fmt(m.spendUsd)}</text>`;
          })
          .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="${height}" viewBox="0 0 480 ${height}" role="img" aria-label="${escapeXml(aria)}">
  <defs>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#1c1610" flood-opacity="0.18"/>
    </filter>
    <pattern id="dots" width="8" height="8" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="0.8" fill="#c4a574" opacity="0.35"/>
    </pattern>
  </defs>
  <rect width="480" height="${height}" fill="#d9cbb0"/>
  <rect x="24" y="18" width="432" height="${height - 36}" rx="4" fill="#f7f0e1" filter="url(#shadow)"/>
  <rect x="24" y="18" width="432" height="10" fill="url(#dots)"/>
  <text x="240" y="58" text-anchor="middle" class="brand">SPENDLIGHT</text>
  <text x="240" y="80" text-anchor="middle" class="sub">${escapeXml(sub)}</text>
  <path d="M48 96 H432" stroke="#1c1610" stroke-opacity="0.2" stroke-dasharray="3 5"/>
  <text x="48" y="122" class="muted">generated</text>
  <text x="432" y="122" class="item amount">${escapeXml(summary.generatedAt.slice(0, 19).replace("T", " "))}Z</text>
  <text x="48" y="144" class="muted">status</text>
  <text x="432" y="144" class="item amount">${escapeXml(status)}</text>
  <path d="M48 158 H432" stroke="#1c1610" stroke-opacity="0.2" stroke-dasharray="3 5"/>
  ${modelLines}
  <path d="M48 ${header + tableH + 18} H432" stroke="#1c1610" stroke-opacity="0.35"/>
  <text x="48" y="${header + tableH + 48}" class="total-label">TOTAL</text>
  <text x="432" y="${header + tableH + 48}" class="total amount">${escapeXml(total)}</text>
  <text x="48" y="${header + tableH + 76}" class="muted">requests ${summary.requests} · tokens ${summary.tokens.toLocaleString("en-US")}</text>
  <text x="48" y="${header + tableH + 98}" class="muted">${escapeXml(hardLabel)} ${escapeXml(hard)}</text>
  ${windowLabel ? `<text x="48" y="${header + tableH + 120}" class="muted">window ${escapeXml(summary.budget.timezone)} · ${escapeXml(fmt(windowSpend))} counted ${escapeXml(windowLabel)}</text>` : ""}
  ${tailSvg}
  <text x="240" y="${height - 28}" text-anchor="middle" class="footer">keep the light on · estimates only</text>
  <style>
    .brand { font: 700 22px "Palatino Linotype", Palatino, "Times New Roman", serif; fill: #1c1610; letter-spacing: 6px; }
    .sub { font: italic 13px "Palatino Linotype", Palatino, serif; fill: #7a6a50; letter-spacing: 3px; }
    .item { font: 13px ui-monospace, "SF Mono", Menlo, monospace; fill: #1c1610; }
    .muted { font: 11px ui-monospace, "SF Mono", Menlo, monospace; fill: #7a6a50; }
    .amount { text-anchor: end; }
    .total { font: 700 20px ui-monospace, "SF Mono", Menlo, monospace; fill: #1c1610; text-anchor: end; }
    .total-label { font: 700 13px ui-sans-serif, system-ui, sans-serif; fill: #1c1610; letter-spacing: 3px; }
    .footer { font: italic 11px "Palatino Linotype", Palatino, serif; fill: #7a6a50; }
  </style>
</svg>`;
}

export function badgeSvg(summary: Summary): string {
  const status = summary.budget.status;
  const label = "spendlight";
  const windowLabel = calendarWindowLabel(summary.budget.period);
  const scoped = summary.scopeProject != null;
  const projectHard = scoped && summary.scopeProject ? summary.budget.projectLimit.hardUsd : null;
  const spendN = windowLabel
    ? scoped
      ? summary.budget.projectSpend
      : summary.budget.globalSpend
    : summary.spendUsd;
  const spend = fmt(spendN);
  const hard = projectHard != null ? projectHard : summary.budget.globalLimit.hardUsd;
  const shown = windowLabel ? `${windowLabel} ${spend}` : spend;
  const value = hard != null ? `${shown} / ${fmt(hard)}` : shown;
  const aria = scoped && summary.scopeProject ? `${label} ${summary.scopeProject}: ${value}` : `${label}: ${value}`;
  const color = status === "hard" ? "#9b2c2c" : status === "soft" ? "#b8862a" : "#2f6f4e";
  const labelW = 82;
  const valueW = Math.max(78, value.length * 7.2 + 16);
  const w = labelW + valueW;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${escapeXml(aria)}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#1c1610"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="14">${escapeXml(value)}</text>
  </g>
</svg>`;
}

function calendarWindowLabel(period: Summary["budget"]["period"]): "today" | "this month" | null {
  if (period === "day") return "today";
  if (period === "month") return "this month";
  return null;
}

function windowRows(summary: Summary): string[] {
  const label = calendarWindowLabel(summary.budget.period);
  if (!label) return [];
  const scoped = summary.scopeProject != null;
  const spend = scoped ? summary.budget.projectSpend : summary.budget.globalSpend;
  const rows = [
    `| Budget window | ${label} (${summary.budget.timezone}) |`,
    `| Spend in window | ${fmt(spend)} |`,
  ];
  if (scoped) rows.push(`| Global spend in window | ${fmt(summary.budget.globalSpend)} |`);
  return rows;
}

function projectBudgetRows(summary: Summary): string[] {
  if (!summary.scopeProject) return [];
  const limit = summary.budget.projectLimit;
  const rows: string[] = [];
  if (limit.hardUsd != null) rows.push(`| Project hard | ${fmt(limit.hardUsd)} |`);
  if (limit.softUsd != null) rows.push(`| Project soft | ${fmt(limit.softUsd)} |`);
  return rows;
}

function globalSpendRow(summary: Summary): string[] {
  if (summary.scopeProject == null || calendarWindowLabel(summary.budget.period)) return [];
  return [`| Global spend | ${fmt(summary.budget.globalSpend)} |`];
}

function statusLabel(summary: Summary): string {
  if (summary.budget.status === "hard") return "HARD KILL-SWITCH";
  if (summary.budget.status === "soft") return "SOFT WARNING";
  return "OK";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}
