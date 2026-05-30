// Electric Garden dashboard logic
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 30000;

let moistureChart, batteryChart, extraChart;
let currentNode = null;

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ago(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function batteryBadge(state, online) {
  if (!online) return `<span class="badge danger"><span class="dotled"></span>OFFLINE</span>`;
  const map = {
    ok: ["ok", "Battery OK"],
    low: ["warn", "Battery LOW"],
    empty: ["danger", "Battery EMPTY"],
    unknown: ["muted", "Battery n/a"],
  };
  const [cls, txt] = map[state] || map.unknown;
  return `<span class="badge ${cls}"><span class="dotled"></span>${txt}</span>`;
}

function moistureLabel(m) {
  if (m == null) return "";
  if (m < 20) return "Very dry 🏜️";
  if (m < 35) return "Dry — needs water 💧";
  if (m < 60) return "Just right 🌿";
  if (m < 80) return "Moist 💦";
  return "Soaked 🌊";
}

// Moisture color zones (kept in sync with moistureLabel thresholds).
const MOISTURE_ZONES = [
  { min: 0,  max: 20,  color: "#d97706", label: "Very dry" },   // desert orange
  { min: 20, max: 35,  color: "#facc15", label: "Dry" },        // warning yellow
  { min: 35, max: 60,  color: "#34d399", label: "Just right" }, // green
  { min: 60, max: 80,  color: "#38bdf8", label: "Moist" },      // light blue
  { min: 80, max: 101, color: "#3b82f6", label: "Soaked" },     // blue
];

function moistureColor(m) {
  if (m == null) return "#8aa99a";
  for (const z of MOISTURE_ZONES) {
    if (m >= z.min && m < z.max) return z.color;
  }
  return "#34d399";
}

// Chart.js plugin: paint faint horizontal background bands for each moisture zone,
// so the "dry" region is visually obvious behind the line.
const moistureZonesPlugin = {
  id: "moistureZones",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.y) return;
    const y = scales.y;
    ctx.save();
    for (const z of MOISTURE_ZONES) {
      const top = y.getPixelForValue(Math.min(z.max, 100));
      const bottom = y.getPixelForValue(z.min);
      ctx.fillStyle = z.color + "14"; // ~8% opacity
      ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bottom - top);
    }
    // Emphasize the "needs water" line at 35%.
    const yLine = y.getPixelForValue(35);
    ctx.strokeStyle = "#facc1555";
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, yLine);
    ctx.lineTo(chartArea.right, yLine);
    ctx.stroke();
    ctx.restore();
  },
};
Chart.register(moistureZonesPlugin);

async function loadNodes() {
  const res = await fetch("/api/nodes");
  const nodes = await res.json();
  const sel = $("nodeSelect");
  const prev = sel.value;
  sel.innerHTML = "";
  if (nodes.length === 0) {
    sel.innerHTML = `<option>No devices yet</option>`;
  }
  nodes.forEach((n) => {
    const o = document.createElement("option");
    o.value = n.node_id;
    o.textContent = n.node_id + (n.online ? "" : " (offline)");
    sel.appendChild(o);
  });
  if (prev && nodes.some((n) => n.node_id === prev)) sel.value = prev;
  currentNode = sel.value || (nodes[0] && nodes[0].node_id) || null;
  renderCards(nodes);
  return nodes;
}

function renderCards(nodes) {
  const node = nodes.find((n) => n.node_id === currentNode) || nodes[0];
  const wrap = $("statusCards");
  if (!node) {
    wrap.innerHTML = `<div class="card"><div class="label">Status</div><div class="value">No data yet</div>
      <div class="meta">Waiting for your ESP32 to send its first reading…</div></div>`;
    return;
  }
  const bvolt = node.battery_voltage != null ? node.battery_voltage.toFixed(2) + " V" : "n/a";
  const bpct = node.battery_percent != null ? Math.round(node.battery_percent) + "%" : "—";
  const humidity = node.humidity != null ? Math.round(node.humidity) + "%" : "not wired";
  const temp = node.temperature != null ? node.temperature.toFixed(1) + " °C" : "n/a";

  wrap.innerHTML = `
    <div class="card${node.moisture != null && node.moisture < 35 ? " card-alert" : ""}">
      <div class="label">Soil Moisture</div>
      <div class="value" style="color:${moistureColor(node.moisture)}">${node.moisture != null ? Math.round(node.moisture) : "—"}<small>%</small></div>
      <div class="meta" style="color:${moistureColor(node.moisture)}">${moistureLabel(node.moisture)}</div>
    </div>
    <div class="card">
      <div class="label">Battery</div>
      <div class="value">${bpct}</div>
      <div class="meta">${bvolt} &nbsp; ${batteryBadge(node.battery_state, node.online)}</div>
    </div>
    <div class="card">
      <div class="label">Connection</div>
      <div class="value">${node.online ? "Online" : "Offline"}</div>
      <div class="meta">Last seen ${ago(node.seconds_since)}</div>
    </div>
    <div class="card">
      <div class="label">Humidity / Temp</div>
      <div class="value" style="font-size:24px;">${humidity} <small>/ ${temp}</small></div>
      <div class="meta">air humidity &amp; temperature</div>
    </div>`;
}

function baseChartOpts(yLabel, yMax) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { color: "#cfe6da" } },
      tooltip: { backgroundColor: "#0c1411", borderColor: "#21362c", borderWidth: 1 },
    },
    scales: {
      x: { ticks: { color: "#8aa99a", maxTicksLimit: 8 }, grid: { color: "#1c2c24" } },
      y: {
        ticks: { color: "#8aa99a" },
        grid: { color: "#1c2c24" },
        title: { display: true, text: yLabel, color: "#8aa99a" },
        suggestedMin: 0,
        suggestedMax: yMax,
      },
    },
  };
}

function gradient(ctx, color) {
  const g = ctx.createLinearGradient(0, 0, 0, 300);
  g.addColorStop(0, color + "55");
  g.addColorStop(1, color + "00");
  return g;
}

async function loadReadings() {
  if (!currentNode) return;
  const hours = $("rangeSelect").value;
  const res = await fetch(`/api/readings?node_id=${encodeURIComponent(currentNode)}&hours=${hours}`);
  const data = await res.json();
  const labels = data.map((r) => fmtTime(r.created_at));
  const moisture = data.map((r) => r.moisture);
  const battery = data.map((r) => r.battery_percent);
  const bvolt = data.map((r) => r.battery_voltage);
  const humidity = data.map((r) => r.humidity);
  const temp = data.map((r) => r.temperature);

  const mctx = $("moistureChart").getContext("2d");
  // Color each line segment by the (lower) moisture value it represents, so the
  // curve turns desert-orange/yellow in dry stretches and green/blue when wet.
  const segColor = (c) => {
    const v = c.p1.parsed.y; // value at the end of this segment
    return moistureColor(v);
  };
  const moistureCfg = {
    labels,
    datasets: [
      {
        label: "Moisture %",
        data: moisture,
        borderColor: "#34d399",
        segment: {
          borderColor: segColor,
        },
        // Fill tinted by the most recent reading's zone.
        backgroundColor: gradient(mctx, moistureColor(moisture[moisture.length - 1])),
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2.5,
      },
    ],
  };
  if (moistureChart) {
    moistureChart.data = moistureCfg;
    moistureChart.update();
  } else {
    moistureChart = new Chart(mctx, { type: "line", data: moistureCfg, options: baseChartOpts("%", 100) });
  }
  const last = moisture[moisture.length - 1];
  const hintEl = $("moistureHint");
  if (last != null) {
    hintEl.textContent = `now: ${Math.round(last)}% — ${moistureLabel(last)}`;
    hintEl.style.color = moistureColor(last);
    hintEl.style.fontWeight = last < 35 ? "700" : "500";
  } else {
    hintEl.textContent = "";
  }

  const bctx = $("batteryChart").getContext("2d");
  const batteryCfg = {
    labels,
    datasets: [
      {
        label: "Battery %",
        data: battery,
        borderColor: "#22d3ee",
        backgroundColor: gradient(bctx, "#22d3ee"),
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
        yAxisID: "y",
      },
      {
        label: "Voltage (V)",
        data: bvolt,
        borderColor: "#fbbf24",
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 1.5,
        yAxisID: "y2",
      },
    ],
  };
  const battOpts = baseChartOpts("%", 100);
  battOpts.scales.y2 = {
    position: "right",
    ticks: { color: "#fbbf24" },
    grid: { drawOnChartArea: false },
    title: { display: true, text: "Volts", color: "#fbbf24" },
    suggestedMin: 3.0,
    suggestedMax: 4.3,
  };
  if (batteryChart) {
    batteryChart.data = batteryCfg;
    batteryChart.options = battOpts;
    batteryChart.update();
  } else {
    batteryChart = new Chart(bctx, { type: "line", data: batteryCfg, options: battOpts });
  }

  // Humidity (left %-axis) + Temperature (right °C-axis) — e.g. from a DHT22.
  const ectx = $("extraChart").getContext("2d");
  const extraCfg = {
    labels,
    datasets: [
      {
        label: "Humidity %",
        data: humidity,
        borderColor: "#60a5fa",
        backgroundColor: gradient(ectx, "#60a5fa"),
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
        yAxisID: "y",
      },
      {
        label: "Temp °C",
        data: temp,
        borderColor: "#f472b6",
        fill: false,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 1.5,
        yAxisID: "y2",
      },
    ],
  };
  const extraOpts = baseChartOpts("Humidity %", 100);
  extraOpts.scales.y2 = {
    position: "right",
    ticks: { color: "#f472b6" },
    grid: { drawOnChartArea: false },
    title: { display: true, text: "Temp °C", color: "#f472b6" },
    suggestedMin: 0,
    suggestedMax: 40,
  };
  if (extraChart) {
    extraChart.data = extraCfg;
    extraChart.options = extraOpts;
    extraChart.update();
  } else {
    extraChart = new Chart(ectx, { type: "line", data: extraCfg, options: extraOpts });
  }
}

async function refreshAll() {
  try {
    await loadNodes();
    await loadReadings();
    $("lastUpdate").textContent = "Updated " + new Date().toLocaleTimeString();
  } catch (e) {
    $("lastUpdate").textContent = "Update failed — backend offline?";
    console.error(e);
  }
}

async function deleteReadings() {
  if (!currentNode) {
    alert("No device selected — nothing to delete.");
    return;
  }
  const scopeAll = confirm(
    `Delete readings.\n\nOK = delete ALL devices' readings.\nCancel = delete only "${currentNode}".`
  );
  const targetNode = scopeAll ? null : currentNode;
  const what = scopeAll ? "ALL devices" : `"${currentNode}"`;
  if (!confirm(`Really delete readings for ${what}? This cannot be undone.`)) return;

  const password = prompt("Enter admin password to delete:");
  if (password === null) return; // cancelled

  try {
    const url = "/api/readings" + (targetNode ? `?node_id=${encodeURIComponent(targetNode)}` : "");
    const res = await fetch(url, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.status === 403) {
      alert("Wrong admin password.");
      return;
    }
    if (!res.ok) {
      alert("Delete failed (HTTP " + res.status + ").");
      return;
    }
    const data = await res.json();
    alert(`Deleted ${data.deleted} reading(s).`);
    // Reset charts so they don't keep stale data for a wiped node.
    [moistureChart, batteryChart, extraChart].forEach((c) => {
      if (c) { c.data.labels = []; c.data.datasets.forEach((d) => (d.data = [])); c.update(); }
    });
    await refreshAll();
  } catch (e) {
    alert("Delete failed — backend offline?");
    console.error(e);
  }
}

$("deleteBtn").addEventListener("click", deleteReadings);

$("nodeSelect").addEventListener("change", (e) => {
  currentNode = e.target.value;
  loadReadings();
});
$("rangeSelect").addEventListener("change", loadReadings);
$("refreshBtn").addEventListener("click", refreshAll);

refreshAll();
setInterval(refreshAll, REFRESH_MS);
