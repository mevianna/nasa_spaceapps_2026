const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      value: id === "city" ? "florianopolis" : id === "variable" ? "T2M" : "",
      textContent: "",
      innerHTML: "",
      className: "",
      disabled: false,
      classList: { add() {}, toggle() {} },
      addEventListener() {},
      setAttribute() {}
    });
  }
  return elements.get(id);
}

const context = {
  console,
  URL,
  URLSearchParams,
  document: {
    getElementById: element,
    querySelector: () => ({ textContent: "" })
  },
  window: { addEventListener() {} },
  fetch: async () => { throw new Error("Network disabled in unit test"); }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync("dist/app.js", "utf8"), context);

const series = [];
for (let year = 2001; year <= 2025; year++) {
  for (let month = 1; month <= 12; month++) {
    const seasonal = 4 * Math.sin((month - 1) / 12 * Math.PI * 2);
    const trend = 0.05 * (year - 2001);
    const outlier = year === 2018 && month === 7 ? 8 : 0;
    series.push({
      key: `${year}${String(month).padStart(2, "0")}`,
      year,
      month,
      time: year + (month - 0.5) / 12,
      value: 20 + seasonal + trend + outlier
    });
  }
}

context.seriesForTest = series;
const result = vm.runInContext("runAnalysis(seriesForTest)", context);
assert(result.regression.slope > 0.045 && result.regression.slope < 0.055, "trend slope should be recovered");
assert(result.regression.significant, "trend should be significant");
assert.strictEqual(result.anomalyCount, 15, "top 5% of 300 months should be marked");
assert(result.adjusted.some(row => row.year === 2018 && row.month === 7 && row.anomaly), "strong outlier should be detected");

console.log("Smoke test passed:", {
  observations: result.adjusted.length,
  annualSlope: result.regression.slope.toFixed(4),
  anomalies: result.anomalyCount
});
