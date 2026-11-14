const CITIES = {
  florianopolis: { name: "Florianópolis", lat: -27.5954, lon: -48.5480 },
  manaus: { name: "Manaus", lat: -3.1190, lon: -60.0217 },
  brasilia: { name: "Brasília", lat: -15.7939, lon: -47.8828 },
  saopaulo: { name: "São Paulo", lat: -23.5505, lon: -46.6333 }
};

const VARIABLES = {
  T2M: {
    name: "Average temperature", unit: "°C", decimals: 2, source: "MERRA-2",
    help: "Average air temperature measured approximately two meters above the surface."
  },
  PRECTOTCORR: {
    name: "Precipitation", unit: "mm/day", decimals: 2, source: "MERRA-2",
    help: "The average amount of rain and other precipitation received per day during each month."
  },
  ALLSKY_SFC_SW_DWN: {
    name: "Solar radiation", unit: "kWh/m²/day", decimals: 2, source: "CERES",
    help: "The solar energy reaching a square meter of the surface each day, including cloudy conditions."
  }
};

const $ = (id) => document.getElementById(id);
const button = $("analyze");

button.addEventListener("click", analyze);
$("variable").addEventListener("change", updateVariableHelp);
window.addEventListener("DOMContentLoaded", () => {
  updateVariableHelp();
  analyze();
});

async function analyze() {
  const city = CITIES[$("city").value];
  const variableKey = $("variable").value;
  const variable = VARIABLES[variableKey];
  setLoading(true);

  try {
    const url = new URL("https://power.larc.nasa.gov/api/temporal/monthly/point");
    url.search = new URLSearchParams({
      parameters: variableKey,
      community: "AG",
      longitude: city.lon,
      latitude: city.lat,
      format: "JSON",
      start: "2001",
      end: "2025"
    });

    const response = await fetch(url);
    if (!response.ok) throw new Error(`NASA POWER returned status ${response.status}`);
    const payload = await response.json();
    const values = payload?.properties?.parameter?.[variableKey];
    if (!values) throw new Error("The response does not contain the requested variable.");

    const series = Object.entries(values)
      .filter(([key, value]) => isMonthlyRecordKey(key) && Number.isFinite(value) && value > -900)
      .map(([key, value]) => ({
        key,
        year: Number(key.slice(0, 4)),
        month: Number(key.slice(4, 6)),
        time: Number(key.slice(0, 4)) + (Number(key.slice(4, 6)) - 0.5) / 12,
        value
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    if (series.length < 60) throw new Error("The returned time series is too short for this analysis.");
    const result = runAnalysis(series);
    render(city, variable, series, result);
    setLoading(false);
  } catch (error) {
    console.error(error);
    $("status").className = "status error";
    $("status").innerHTML = `We could not retrieve the data right now.<br>${escapeHtml(error.message)}<br><small>Please try again in a few seconds.</small>`;
    $("result-content").classList.add("is-hidden");
    button.disabled = false;
  }
}

function runAnalysis(series) {
  const monthlyMeans = Array.from({ length: 12 }, (_, i) => mean(series.filter(d => d.month === i + 1).map(d => d.value)));
  const overallMean = mean(series.map(d => d.value));
  const adjusted = series.map(d => ({ ...d, adjusted: d.value - monthlyMeans[d.month - 1] + overallMean }));
  const regression = linearRegression(adjusted.map(d => d.time), adjusted.map(d => d.adjusted));

  adjusted.forEach((d, i) => {
    d.trend = regression.intercept + regression.slope * d.time;
    d.residual = d.adjusted - d.trend;
    d.delta = i ? d.adjusted - adjusted[i - 1].adjusted : 0;
  });

  const features = standardize2D(adjusted.map(d => [d.residual, d.delta]));
  const scores = isolationForest(features, 72, Math.min(128, features.length), 2026);
  const targetAnomalies = Math.max(1, Math.ceil(scores.length * 0.05));
  const anomalyIndices = new Set(scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, targetAnomalies)
    .map(item => item.index));
  adjusted.forEach((d, i) => { d.anomaly = anomalyIndices.has(i); d.anomalyScore = scores[i]; });

  return { adjusted, regression, anomalyCount: adjusted.filter(d => d.anomaly).length };
}

function linearRegression(xs, ys) {
  const xMean = mean(xs), yMean = mean(ys);
  const sxx = xs.reduce((s, x) => s + (x - xMean) ** 2, 0);
  const sxy = xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0);
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const residuals = ys.map((y, i) => y - (intercept + slope * xs[i]));
  const residualVariance = residuals.reduce((s, r) => s + r ** 2, 0) / (xs.length - 2);
  const standardError = Math.sqrt(residualVariance / sxx);
  const ci = 1.96 * standardError;
  const syy = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
  const r2 = syy ? 1 - residuals.reduce((s, r) => s + r ** 2, 0) / syy : 0;
  return { slope, intercept, ci, significant: Math.abs(slope) > ci, r2 };
}

function isolationForest(data, treeCount, sampleSize, seed) {
  const random = mulberry32(seed);
  const maxDepth = Math.ceil(Math.log2(sampleSize));
  const trees = Array.from({ length: treeCount }, () => {
    const sample = shuffleIndices(data.length, random).slice(0, sampleSize).map(i => data[i]);
    return buildIsolationTree(sample, 0, maxDepth, random);
  });
  const normalizer = averagePathLength(sampleSize);
  return data.map(point => {
    const avgPath = mean(trees.map(tree => pathLength(point, tree, 0)));
    return Math.pow(2, -avgPath / normalizer);
  });
}

function buildIsolationTree(points, depth, maxDepth, random) {
  if (depth >= maxDepth || points.length <= 1) return { size: points.length };
  const feature = random() < .5 ? 0 : 1;
  const values = points.map(p => p[feature]);
  const min = Math.min(...values), max = Math.max(...values);
  if (min === max) return { size: points.length };
  const split = min + random() * (max - min);
  const left = points.filter(p => p[feature] < split);
  const right = points.filter(p => p[feature] >= split);
  if (!left.length || !right.length) return { size: points.length };
  return { feature, split, left: buildIsolationTree(left, depth + 1, maxDepth, random), right: buildIsolationTree(right, depth + 1, maxDepth, random) };
}

function pathLength(point, node, depth) {
  if (node.size !== undefined) return depth + averagePathLength(node.size);
  return pathLength(point, point[node.feature] < node.split ? node.left : node.right, depth + 1);
}

function averagePathLength(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  const harmonic = Math.log(n - 1) + 0.5772156649;
  return 2 * harmonic - 2 * (n - 1) / n;
}

function standardize2D(rows) {
  const means = [mean(rows.map(r => r[0])), mean(rows.map(r => r[1]))];
  const stds = [0, 1].map(j => Math.sqrt(mean(rows.map(r => (r[j] - means[j]) ** 2))) || 1);
  return rows.map(r => r.map((v, j) => (v - means[j]) / stds[j]));
}

function render(city, variable, series, result) {
  const { regression, adjusted, anomalyCount } = result;
  const decadeSlope = regression.slope * 10;
  const absSlope = Math.abs(decadeSlope).toFixed(variable.decimals);
  const direction = decadeSlope > 0 ? "increase" : decadeSlope < 0 ? "decrease" : "no change";

  $("result-title").textContent = `${variable.name} em ${city.name}`;
  $("slope").textContent = `${decadeSlope > 0 ? "+" : ""}${decadeSlope.toFixed(variable.decimals)} ${variable.unit}`;
  $("direction").textContent = `estimated ${direction} per decade`;
  $("significance").textContent = regression.significant ? "Significant" : "Inconclusive";
  $("confidence").textContent = `95% CI: ±${(regression.ci * 10).toFixed(variable.decimals)} ${variable.unit}`;
  $("anomaly-count").textContent = `${anomalyCount} months`;
  document.querySelector(".data-badge").textContent = `NASA • ${variable.source}`;

  const significanceText = regression.significant
    ? "The confidence interval does not include zero, so the direction of the trend is statistically consistent."
    : "The confidence interval includes zero, so the data does not support a clear trend direction.";
  $("summary").textContent = `Between 2001 and 2025, ${variable.name.toLowerCase()} in ${city.name} showed an estimated ${direction} of ${absSlope} ${variable.unit} per decade. ${significanceText} The model identified ${anomalyCount} unusual months.`;

  renderChart(series, adjusted, regression, variable);
}

function renderChart(series, adjusted, regression, variable) {
  const width = 900, height = 300, pad = { l: 56, r: 18, t: 18, b: 36 };
  const values = series.map(d => d.value);
  const minY = Math.min(...values), maxY = Math.max(...values);
  const rangeY = maxY - minY || 1;
  const x = i => pad.l + i / (series.length - 1) * (width - pad.l - pad.r);
  const y = value => pad.t + (maxY - value) / rangeY * (height - pad.t - pad.b);
  const observedPath = series.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");

  const trendStartAdjusted = regression.intercept + regression.slope * adjusted[0].time;
  const trendEndAdjusted = regression.intercept + regression.slope * adjusted.at(-1).time;
  const trendStartRaw = trendStartAdjusted - mean(adjusted.map(d => d.adjusted)) + mean(series.map(d => d.value));
  const trendEndRaw = trendEndAdjusted - mean(adjusted.map(d => d.adjusted)) + mean(series.map(d => d.value));
  const ticks = [0, .25, .5, .75, 1].map(t => minY + t * rangeY);
  const years = [2001, 2007, 2013, 2019, 2025];

  const svg = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
      ${ticks.map(v => `<line x1="${pad.l}" y1="${y(v)}" x2="${width-pad.r}" y2="${y(v)}" stroke="rgba(23,37,30,.09)"/><text x="${pad.l-9}" y="${y(v)+3}" text-anchor="end" fill="#7a837e" font-size="9" font-family="DM Mono">${v.toFixed(variable.decimals)}</text>`).join("")}
      <path d="${observedPath}" fill="none" stroke="#245c3f" stroke-width="1.5" opacity=".72" vector-effect="non-scaling-stroke"/>
      <line x1="${x(0)}" y1="${y(trendStartRaw)}" x2="${x(series.length-1)}" y2="${y(trendEndRaw)}" stroke="#8ebd32" stroke-width="3" stroke-dasharray="7 5" vector-effect="non-scaling-stroke"/>
      ${adjusted.map((d, i) => d.anomaly ? `<circle cx="${x(i)}" cy="${y(series[i].value)}" r="3.5" fill="#e94f37" stroke="#fbfaf5" stroke-width="1.5" vector-effect="non-scaling-stroke"><title>${d.month.toString().padStart(2,"0")}/${d.year}: ${series[i].value.toFixed(variable.decimals)} ${variable.unit}</title></circle>` : "").join("")}
      ${years.map(year => { const i = series.findIndex(d => d.year === year); return `<text x="${x(Math.max(i,0))}" y="${height-10}" text-anchor="middle" fill="#7a837e" font-size="9" font-family="DM Mono">${year}</text>`; }).join("")}
    </svg>`;
  $("chart").innerHTML = svg;
  $("chart").setAttribute("aria-label", `Monthly ${variable.name.toLowerCase()} from 2001 to 2025, with trend and anomalies.`);
}

function setLoading(loading) {
  button.disabled = loading;
  $("status").className = loading ? "status" : "status is-hidden";
  $("status").innerHTML = loading ? '<span class="spinner"></span> Retrieving NASA POWER data…' : "";
  $("result-content").classList.toggle("is-hidden", loading);
}

function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }
function updateVariableHelp() {
  const variable = VARIABLES[$("variable").value];
  $("variable-help").querySelector("span").textContent = variable.help;
}
function isMonthlyRecordKey(key) {
  if (!/^\d{6}$/.test(key)) return false;
  const month = Number(key.slice(4, 6));
  return month >= 1 && month <= 12;
}
function shuffleIndices(n, random) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function mulberry32(seed) {
  return function () { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function escapeHtml(text) { return String(text).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
