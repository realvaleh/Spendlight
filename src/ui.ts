export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Spendlight</title>
  <link rel="icon" href="/favicon.svg"/>
  <style>
    :root {
      --paper: #f3ead8;
      --paper-2: #e8dcc4;
      --ink: #1c1610;
      --muted: #6e6253;
      --gold: #b8862a;
      --gold-2: #e0b34a;
      --green: #2f6f4e;
      --red: #9b2c2c;
      --line: rgba(28,22,16,.12);
      --shadow: 0 18px 50px rgba(28,22,16,.12);
      --serif: "Iowan Old Style", Palatino, "Palatino Linotype", "Times New Roman", serif;
      --sans: "Segoe UI", ui-sans-serif, system-ui, sans-serif;
      --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--sans); }
    body {
      min-height: 100vh;
      background-image:
        radial-gradient(1200px 500px at 10% -10%, rgba(224,179,74,.18), transparent 50%),
        radial-gradient(900px 400px at 110% 0%, rgba(47,111,78,.08), transparent 45%);
    }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 80px; }
    header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 28px; }
    .brand { font-family: var(--serif); font-size: 34px; letter-spacing: -.02em; margin: 0; }
    .brand span { font-style: italic; color: var(--gold); font-weight: 400; }
    .lede { color: var(--muted); margin: 6px 0 0; font-size: 14px; }
    .pill { font-family: var(--mono); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; padding: 7px 11px; border: 1px solid var(--line); border-radius: 999px; background: #fff8ea; }
    .pill.ok { color: var(--green); }
    .pill.soft { color: var(--gold); }
    .pill.hard { color: var(--red); background: #f8e8e4; }
    .hero {
      display: grid; grid-template-columns: 1.4fr .8fr; gap: 18px; margin-bottom: 18px;
    }
    .card {
      background: #fffaf0; border: 1px solid var(--line); border-radius: 18px;
      box-shadow: var(--shadow); padding: 22px 24px;
    }
    .k { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
    .hero-spend { font-family: var(--serif); font-size: clamp(40px, 6vw, 64px); margin: 8px 0 4px; line-height: 1; }
    .sub { color: var(--muted); font-size: 13px; }
    .meter { height: 10px; background: var(--paper-2); border-radius: 99px; overflow: hidden; margin: 16px 0 8px; }
    .meter > i { display: block; height: 100%; background: linear-gradient(90deg, var(--gold), var(--gold-2)); }
    .meter.soft > i { background: linear-gradient(90deg, #c48a1a, #e0b34a); }
    .meter.hard > i { background: linear-gradient(90deg, #9b2c2c, #d45a4a); }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .stat-n { font-family: var(--mono); font-size: 22px; margin-top: 8px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-bottom: 18px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 8px 0; border-bottom: 1px dashed var(--line); }
    td { padding: 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
    td.num, th.num { text-align: right; font-family: var(--mono); }
    .bar { height: 6px; background: var(--paper-2); border-radius: 99px; margin-top: 6px; }
    .bar > i { display: block; height: 100%; background: var(--ink); border-radius: 99px; opacity: .75; }
    .spark { width: 100%; height: 72px; display: none; }
    .spark polyline { fill: none; stroke: var(--gold); stroke-width: 2; }
    .spark polygon { fill: rgba(184,134,42,.12); }
    .row-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .links { display: flex; gap: 10px; flex-wrap: wrap; }
    a.btn { color: var(--ink); text-decoration: none; font-size: 12px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 999px; background: #fff8ea; }
    a.btn:hover { border-color: var(--ink); }
    footer { margin-top: 22px; color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .empty { padding: 28px 8px; color: var(--muted); font-family: var(--serif); font-style: italic; }
    code { font-family: var(--mono); font-size: 12px; background: var(--paper-2); padding: 1px 5px; border-radius: 4px; }
    .events { list-style: none; padding: 0; margin: 0; }
    .events li { font-size: 13px; padding: 8px 0; border-bottom: 1px solid var(--line); }
    @media (max-width: 820px) {
      .hero, .grid, .stats { grid-template-columns: 1fr; }
      header { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1 class="brand">Spend<span>light</span></h1>
        <p class="lede">Local OpenAI proxy · spend ledger · budgets · receipts</p>
      </div>
      <div id="status-pill" class="pill">loading</div>
    </header>

    <section class="hero">
      <article class="card">
        <div class="k">Estimated spend</div>
        <div class="hero-spend" id="spend">$0.00</div>
        <div class="sub" id="spend-sub">Waiting for the first completion…</div>
        <div class="meter" id="meter"><i id="meter-bar" style="width:0%"></i></div>
        <div class="sub" id="budget-copy">No hard budget configured.</div>
        <svg class="spark" id="spark" viewBox="0 0 300 72" preserveAspectRatio="none" aria-hidden="true"></svg>
      </article>
      <article class="card">
        <div class="stats">
          <div><div class="k">Requests</div><div class="stat-n" id="requests">0</div></div>
          <div><div class="k">Tokens</div><div class="stat-n" id="tokens">0</div></div>
          <div><div class="k">Avg / req</div><div class="stat-n" id="avg">$0</div></div>
          <div><div class="k">Projects</div><div class="stat-n" id="projects">0</div></div>
        </div>
        <div class="row-head" style="margin-top:18px">
          <div class="k">Share</div>
        </div>
        <div class="links">
          <a class="btn" href="/receipt.md">Markdown receipt</a>
          <a class="btn" href="/receipt.svg">SVG receipt</a>
          <a class="btn" href="/badge.svg">README badge</a>
          <a class="btn" href="/api/export.csv" download="spendlight-ledger.csv">Download CSV</a>
        </div>
      </article>
    </section>

    <section class="grid">
      <article class="card">
        <div class="k">By project</div>
        <div id="by-project" class="empty">No projects yet.</div>
      </article>
      <article class="card">
        <div class="k">By model</div>
        <div id="by-model" class="empty">No models yet.</div>
      </article>
    </section>

    <article class="card" style="margin-bottom:18px">
      <div class="row-head">
        <div class="k">Recent requests</div>
        <div class="sub">auto-refresh 3s</div>
      </div>
      <div id="recent" class="empty">Point a client at <code>/v1</code> to light this up.</div>
    </article>

    <article class="card">
      <div class="k">Budget events</div>
      <ul class="events" id="events"><li class="empty" style="border:0;padding-left:0">None yet.</li></ul>
    </article>

    <footer>
      <div>v1 · cost, budgets, and receipts only. Drop-in OpenAI base URL.</div>
      <div>Tag traffic with <code>x-spendlight-project</code></div>
    </footer>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    const fmtMoney = (n) => {
      if (n >= 1) return "$" + n.toFixed(2);
      if (n >= 0.01) return "$" + n.toFixed(4);
      return "$" + n.toFixed(6);
    };
    const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
    function pill(status) {
      const el = $("status-pill");
      el.className = "pill " + status;
      el.textContent = status === "hard" ? "kill-switch" : status === "soft" ? "soft warning" : "all clear";
    }
        function spark(daily) {
      const svg = $("spark");
      if (!daily || daily.length < 2) { svg.innerHTML = ""; svg.style.display = "none"; return; }
      svg.style.display = "block";
      const vals = daily.map(d => d.spendUsd);
      const max = Math.max(...vals, 1e-9);
      const w = 300, h = 72, p = 4;
      const pts = vals.map((v, i) => {
        const x = p + (i * (w - p * 2)) / Math.max(vals.length - 1, 1);
        const y = h - p - (v / max) * (h - p * 2);
        return x.toFixed(1) + "," + y.toFixed(1);
      });
      const line = pts.join(" ");
      const poly = p + "," + (h - p) + " " + line + " " + (w - p) + "," + (h - p);
      svg.innerHTML = '<polygon points="' + poly + '"></polygon><polyline points="' + line + '"></polyline>';
    }
    function table(headers, rows) {
      if (!rows.length) return null;
      const thead = "<tr>" + headers.map(h => "<th" + (h.num ? ' class="num"' : "") + ">" + h.label + "</th>").join("") + "</tr>";
      const body = rows.map(r => "<tr>" + r.map((c, i) => "<td" + (headers[i].num ? ' class="num"' : "") + ">" + c + "</td>").join("") + "</tr>").join("");
      return "<table><thead>" + thead + "</thead><tbody>" + body + "</tbody></table>";
    }
    async function tick() {
      const s = await fetch("/api/summary").then(r => r.json());
      $("spend").textContent = fmtMoney(s.spendUsd);
      $("requests").textContent = fmtInt(s.requests);
      $("tokens").textContent = fmtInt(s.tokens);
      $("projects").textContent = fmtInt(s.byProject.length);
      $("avg").textContent = s.requests ? fmtMoney(s.spendUsd / s.requests) : "$0";
      $("spend-sub").textContent = s.requests
        ? s.tokens.toLocaleString("en-US") + " tokens across " + s.requests + " request" + (s.requests === 1 ? "" : "s")
        : "Waiting for the first completion…";
      pill(s.budget.status);
      const hard = s.budget.globalLimit.hardUsd;
      const spend = s.budget.globalSpend;
      const pct = hard ? Math.min(100, (spend / hard) * 100) : 0;
      $("meter").className = "meter " + s.budget.status;
      $("meter-bar").style.width = (hard ? pct : 0) + "%";
      $("budget-copy").textContent = hard == null
        ? "No global hard budget configured."
        : "Hard budget " + fmtMoney(spend) + " / " + fmtMoney(hard) + (s.budget.globalLimit.softUsd != null ? " · soft " + fmtMoney(s.budget.globalLimit.softUsd) : "");
      spark(s.daily || []);
      const maxP = Math.max(...s.byProject.map(p => p.spendUsd), 1e-9);
      const proj = table(
        [{label:"Project"},{label:"Spend",num:true},{label:"Reqs",num:true}],
        s.byProject.map(p => [
          esc(p.project) + '<div class="bar"><i style="width:' + (p.spendUsd / maxP * 100) + '%"></i></div>',
          fmtMoney(p.spendUsd),
          p.requests
        ])
      );
      $("by-project").innerHTML = proj || '<div class="empty">No projects yet.</div>';
      const models = table(
        [{label:"Model"},{label:"Spend",num:true},{label:"Tokens",num:true}],
        s.byModel.map(m => ["<code>" + esc(m.model) + "</code>", fmtMoney(m.spendUsd), fmtInt(m.tokens)])
      );
      $("by-model").innerHTML = models || '<div class="empty">No models yet.</div>';
      const recent = table(
        [{label:"When"},{label:"Project"},{label:"Model"},{label:"Tokens",num:true},{label:"Cost",num:true}],
        s.recent.map(r => [
          new Date(r.createdAt).toLocaleString(),
          esc(r.project),
          "<code>" + esc(r.model) + "</code>",
          fmtInt(r.totalTokens),
          fmtMoney(r.costUsd)
        ])
      );
      $("recent").innerHTML = recent || '<div class="empty">Point a client at <code>/v1</code> to light this up.</div>';
      $("events").innerHTML = s.events.length
        ? s.events.map(e => "<li><strong>" + esc(e.type) + "</strong> · " + esc(e.project) + " · " + esc(e.message) + "</li>").join("")
        : '<li class="empty" style="border:0;padding-left:0">None yet.</li>';
    }
    tick();
    setInterval(tick, 3000);
  </script>
</body>
</html>`;
}

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#1c1610"/>
  <path d="M16 6c4 5 6 8 6 12a6 6 0 1 1-12 0c0-4 2-7 6-12z" fill="#e0b34a"/>
</svg>`;
