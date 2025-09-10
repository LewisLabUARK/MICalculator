import { WebR } from "https://webr.r-wasm.org/latest/webr.mjs";

/* ---- element look-ups ---- */
const $ = (id) => document.getElementById(id);
const el = {
  loadingStatus: $("loading-status"),
  loadingMessage: $("loading-message"),
  runBtn: $("run-analysis-button"),

  csvInput: $("csv-file-input"),
  exampleBtn: $("load-example-button"),

  variableSection: $("variable-mapping-section"),
  resultsSection: $("results-section"),

  errorBox: $("error-output"),
  errorMsg: $("error-message"),

  scoreSel: $("score-var-select"),
  concSel: $("concentration-var-select"),
  fac1Sel: $("factor1-var-select"),
  fac2Sel: $("factor2-var-select"),

  fac1BaselineContainer: $("factor1-baseline-container"),
  fac1BaselineSel: $("factor1-baseline-select"),
  fac2BaselineContainer: $("factor2-baseline-container"),
  fac2BaselineSel: $("factor2-baseline-select"),

  linkSel: $("link-function-select"),
  rhsInput: $("model-formula-rhs-input"),
  availVars: $("available-vars-formula"),

  plotTypeSel: $("plot-type-select"),
  plotHelp: $("plot-help-text"),
  plotDiv: $("plot-output-div"),

  modelSummary: $("model-summary-content"),
  micTable: $("mic-table-content"),

  pairwiseBlock: $("pairwise-mic-output"),
  deltaTable: $("delta-mic-table-content"),
  ratioTable: $("ratio-mic-table-content"),

  dodBlock: $("dod-output"),
  dodRatioTable: $("dod-ratio-mic-table-content"),
  dodDeltaTable: $("dod-delta-mic-table-content"),

  diagText: $("diagnostics-test-content"),

  resetBtn: $("reset-app-button"),
  sideDownload: $("side-download-btn"),        // <— renamed
  filterPairs: $("filter-pairs-checkbox"),
};

/* ---- state ---- */
let parsedData = [],
  cols = [],
  last = {},
  analysisDone = false;
let groupCols = [];

/* ---- helpers ---- */
const svgCache = Object.create(null);

// tune once here; you can wire these to UI later if you want
const PLOT_W = 9, PLOT_H = 5.2, PLOT_PT = 12;  // <— semicolon added

/** Ask R to render a single plot SVG if we don’t have it cached yet. */
async function getPlotSVG(type) {
  if (svgCache[type]) return svgCache[type];

  // Build a small R call string. We pass sizes explicitly.
  const rCall = `
    tryCatch(
      .render_plot_svg(${JSON.stringify(type)}, w=${PLOT_W}, h=${PLOT_H}, pointsize=${PLOT_PT}),
      error = function(e) NA_character_
    )
  `;

  const res = await window.webR.evalR(rCall);
  const js = await res.toJs();
  const svg = (js?.values && js.values[0]) || null; // character vector length 1
  if (!svg || svg === "NA") return null;
  svgCache[type] = svg;
  return svg;
}

function sanitizeSVGForFile(svg) {
  if (!svg) return svg;
  let s = String(svg).trim();

  if (!/^<\?xml\b/.test(s)) {
    s = `<?xml version="1.0" encoding="UTF-8"?>\n` + s;
  }
  if (/^<svg\b/i.test(s) && !/\sxmlns=/.test(s)) {
    s = s.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!/viewBox=/.test(s)) {
    const m = s.match(/width="([\d.]+)in"[^>]*height="([\d.]+)in"/i);
    if (m) {
      const wPx = Math.round(parseFloat(m[1]) * 96);
      const hPx = Math.round(parseFloat(m[2]) * 96);
      s = s.replace(/^<svg\b/i, `<svg viewBox="0 0 ${wPx} ${hPx}"`);
    }
  }
  return s;
}

function softClearNode(node, placeholder = "") {
  if (!node) return;
  node.innerHTML = placeholder;
}

async function resetApp() {
  // JS state
  parsedData = [];
  cols = [];
  last = {};
  analysisDone = false;
  groupCols = [];
  for (const k of Object.keys(svgCache)) delete svgCache[k];

  // UI state
  el.variableSection.classList.add("hidden");
  el.resultsSection.classList.add("hidden");
  el.errorBox.classList.add("hidden");
  el.runBtn.disabled = true;
  el.runBtn.textContent = "Run Analysis";

  // Clear selects and labels
  [el.scoreSel, el.concSel, el.fac1Sel, el.fac2Sel].forEach((sel) => {
    if (sel) sel.innerHTML = "<option value=''>-- select a column --</option>";
  });
  el.fac1BaselineContainer.classList.add("hidden");
  el.fac2BaselineContainer.classList.add("hidden");
  el.rhsInput.value = "";
  el.availVars.textContent = "";

  // Clear outputs
  softClearNode(el.plotDiv, '<div class="text-gray-500 p-3">Awaiting plot...</div>');
  softClearNode(el.modelSummary, "Awaiting results...");
  softClearNode(el.micTable, "Awaiting results...");
  softClearNode(el.deltaTable, "Awaiting results...");
  softClearNode(el.ratioTable, "Awaiting results...");
  softClearNode(el.dodRatioTable, "Awaiting results...");
  softClearNode(el.dodDeltaTable, "Awaiting results...");
  el.pairwiseBlock.classList.add("hidden");
  el.dodBlock.classList.add("hidden");
  el.diagText.textContent = "Awaiting results...";

  // Disable download buttons
  const dlBtn = document.getElementById("download-bundle");
  if (dlBtn) { dlBtn.disabled = true; dlBtn.setAttribute("disabled","disabled"); }
  if (el.sideDownload) {
    el.sideDownload.disabled = true;
    el.sideDownload.classList.add("opacity-50","pointer-events-none");
  }

  // R side: drop only our globals; keep packages installed
  try {
    await window.webR.evalRVoid(`
      for (nm in c(".mic_env",".build_plot",".render_plot_svg")) {
        if (exists(nm, envir=.GlobalEnv, inherits=FALSE)) rm(list=nm, envir=.GlobalEnv)
      }
      invisible(gc())
    `);
  } catch (e) {
    console.warn("Reset R globals failed (safe to ignore):", e);
  }

  // Status line
  el.loadingStatus.innerHTML = '<span class="text-blue-600">Ready.</span>';
}
// Detect the transformation applied to the concentration in the RHS.
// Returns R code strings for transform_fun and inv_transform_fun.
function pickTransform(rhs, concName) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const rhsN = norm(rhs);
  const c1 = "`" + concName + "`";           // backticked
  const c2 = concName;                        // bare
  const has = (fn) =>
    rhsN.includes(`${fn}(${norm(c1)})`) || rhsN.includes(`${fn}(${norm(c2)})`);

  // log1p(x)  <->  expm1(y)
  if (has("log1p")) {
    return {
      tf:  "log1p",
      inv: "expm1"
    };
  }
  // log10(x)  <->  10^y
  if (has("log10")) {
    return {
      tf:  "log10",
      inv: "function(y) 10^y"
    };
  }
  // log(x)  <->  exp(y)     (natural log)
  if (has("log")) {
    return {
      tf:  "log",
      inv: "exp"
    };
  }
  // sqrt(x)  <->  y^2
  if (has("sqrt")) {
    return {
      tf:  "sqrt",
      inv: "function(y) y^2"
    };
  }
  // default: identity
  return {
    tf:  "identity",
    inv: "identity"
  };
}

const showSpinner = (node, msg) => {
  node.innerHTML = `<div class="flex flex-col items-center justify-center text-gray-500 h-full p-4"><div class="spinner w-8 h-8 border-4 border-gray-200 rounded-full mb-2"></div><p>${msg}</p></div>`;
};

function numFmt(x, dec = 3) {
  return typeof x === "number" && isFinite(x) ? x.toFixed(dec) : String(x);
}

function renderTable(element, data, noDataMsg = "No data available.") {
  if (!data || data.length === 0) {
    element.innerHTML = `<p class="text-gray-500 text-sm">${noDataMsg}</p>`;
    return;
  }

  const headers = Object.keys(data[0]);

  const headHTML = headers
    .map(h => `<th class="p-2 border-b text-left text-sm font-semibold text-gray-600 bg-gray-50 whitespace-normal break-words align-top">${h}</th>`)
    .join("");

  const bodyHTML = data.map(row => {
    const tds = headers.map(h => {
      const v = row[h];
      const html = (typeof v === "number" && isPColumn(h)) ? pFmt(v) : numFmt(v);
      return `<td class="p-2 border-b text-sm font-mono whitespace-normal break-words align-top max-w-[18rem]">${html}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");

  element.innerHTML =
    `<div class="overflow-x-auto">
       <table class="w-full border-collapse table-auto">
         <thead><tr>${headHTML}</tr></thead>
         <tbody>${bodyHTML}</tbody>
       </table>
     </div>`;

  // Now the table exists; wire up sorting
  const table = element.querySelector("table");
  if (!table) return;

  const ths = table.querySelectorAll("thead th");
  ths.forEach((th, idx) => {
    th.classList.add("cursor-pointer", "select-none");
    th.title = "Click to sort";
    th.addEventListener("click", () => {
      const key = headers[idx];
      const current = th.getAttribute("data-sort-dir");
      const dir = current === "asc" ? "desc" : "asc";
      ths.forEach(t => t.removeAttribute("data-sort-dir"));
      th.setAttribute("data-sort-dir", dir);

      const asNumber = (v) => {
        if (typeof v === "number") return { isNum: true, val: v };
        const n = Number(String(v).replace(/,/g, ""));
        return Number.isFinite(n) ? { isNum: true, val: n } : { isNum: false, val: String(v ?? "") .toLowerCase() };
      };

      const sorted = [...data].sort((a, b) => {
        const A = asNumber(a[key]), B = asNumber(b[key]);
        if (A.isNum && B.isNum) return dir === "asc" ? A.val - B.val : B.val - A.val;
        if (A.val < B.val) return dir === "asc" ? -1 : 1;
        if (A.val > B.val) return dir === "asc" ? 1 : -1;
        return 0;
      });

      // re-render with the sorted data (listeners will be reattached)
      renderTable(element, sorted, noDataMsg);
    });
  });
}


// === p-value helpers (drop any other p helpers you had) ===
const P_COL_REGEX = /^(p(_?value)?|P_value|P|Pr\(>\|z\|\))$/i;
function isPColumn(h) { return P_COL_REGEX.test(h); }

function pFmt(x) {
  if (x == null || !isFinite(x)) return String(x);
  if (x === 0) {
    return '<span class="whitespace-nowrap">&lt;1×10<sup style="vertical-align:super;font-size:0.8em">-300</sup></span>';
  }
  if (x < 1e-3) {
    const exp = Math.floor(Math.log10(x));
    const mant = x / Math.pow(10, exp);
    return `<span class="whitespace-nowrap">${mant.toPrecision(2)}×10<sup style="vertical-align:super;font-size:0.8em">${exp}</sup></span>`;
  }
  return String(+x.toFixed(3));
}

function renderSVG(svgString) {
  if (!svgString) {
    el.plotDiv.innerHTML = '<div class="text-gray-500 p-3">No plot available.</div>';
    return;
  }
  const blob = new Blob([svgString], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  el.plotDiv.innerHTML = ""; // clear container
  const img = new Image();
  img.onload = () => URL.revokeObjectURL(url);
  img.src = url;
  img.style.maxWidth = "100%";
  img.style.height = "auto";
  el.plotDiv.appendChild(img);
}

function renderModelSummary(element, summary) {
  if (
    !summary ||
    !Array.isArray(summary.coefficients) ||
    !Array.isArray(summary.thresholds)
  ) {
    element.innerHTML =
      "<p class='text-gray-500 text-sm'>Model summary unavailable.</p>";
    return;
  }

  const makeHtml = (title, rows) => {
    if (!rows || rows.length === 0) {
      return `<h5 class="font-medium mt-4 mb-1 text-gray-700">${title}</h5>
              <p class="text-gray-500 text-sm">No data available.</p>`;
    }

    const heads = Object.keys(rows[0]);

    const thead = heads.map(
      h => `<th class="p-2 border-b text-left text-xs font-bold text-gray-600 bg-gray-50 whitespace-normal break-words align-top">${h}</th>`
    ).join("");

    const tbody = rows.map(r => {
      const tds = heads.map(h => {
        const v = r[h];
        const html = isPColumn(h) && typeof v === "number" ? pFmt(v) : numFmt(v);
        return `<td class="p-2 border-b text-xs font-mono whitespace-normal break-words align-top max-w-[18rem]">${html}</td>`;
      }).join("");
      return `<tr>${tds}</tr>`;
    }).join("");

    return `
      <h5 class="font-medium mt-4 mb-1 text-gray-700">${title}</h5>
      <div class="overflow-x-auto">
        <table class="w-full border-collapse table-auto">
          <thead><tr>${thead}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;
  };

  element.innerHTML =
    makeHtml("Coefficients", summary.coefficients) +
    makeHtml("Thresholds (Cut-points)", summary.thresholds);
}

function projectColumns(rows, keep) {
  return (rows || []).map((r) => {
    const o = {};
    keep.forEach((k) => (o[k] = r[k] ?? null));
    return o;
  });
}

function downloadCSV(data, filename) {
  if (!data || data.length === 0) {
    alert("No data available to download.");
    return;
  }
  const csv = Papa.unparse(data);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function detectGroupColsFromMics(mics) {
  if (Array.isArray(mics) && mics.length > 0) {
    const known = new Set([
      "MIC",
      "SE_LP",
      "CI_Lower",
      "CI_Upper",
      "Ratio_MIC",
      "Delta_MIC",
      "Estimate",
      "log2Estimate",
      "log2Lower",
      "log2Upper",
      "log2Ratio_MIC",
      "SE_log2Ratio",
      "SE_logDoD",
      "SE_DoD",
      "P_value",
      "DDlog2MIC",
      "DDMIC",
      "Group1",
      "Group2",
      "label",
      "Comparison",
      "contrast",
      "var1",
      "var2",
      "var1_lvlA",
      "var1_lvlB",
      "var2_lvlC",
      "var2_lvlD",
    ]);
    const keys = Object.keys(mics[0]).filter((k) => !known.has(k));
    return keys.slice(0, 3);
  }
  return [el.fac1Sel.value, el.fac2Sel.value].filter(Boolean);
}

function populateBaselineSelector(factorSelect, baselineContainer, baselineSelect) {
  const selectedFactor = factorSelect.value;
  baselineSelect.innerHTML = "";
  baselineContainer.classList.add("hidden");
  if (!selectedFactor || !parsedData.length) return;

  const uniq = [
    ...new Set(
      parsedData
        .map((r) => r[selectedFactor])
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
        .map((v) => String(v).trim())
    ),
  ];
  if (uniq.length >= 1) {
    uniq.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const level of uniq) {
      baselineSelect.insertAdjacentHTML(
        "beforeend",
        `<option value="${level}">${level}</option>`
      );
    }
    baselineContainer.classList.remove("hidden");
    baselineSelect.disabled = uniq.length === 1;
  }
}

/* ------ explode Group1/Group2 for ratio/delta facets ------ */
function explodeGroups(row, fvars) {
  const explode = (str) => {
    const parts = String(str).split(":");
    const o = {};
    fvars.forEach((v, i) => (o[v] = parts[i] ?? ""));
    return o;
  };
  const g1 = explode(row.Group1);
  const g2 = explode(row.Group2);
  return { g1, g2 };
}

/* ---- init webR ---- */
async function initWebR() {
  el.loadingMessage.textContent = "Initializing webR core…";
  window.webR = new WebR({ captureStreams: true });
  await window.webR.init();

  el.loadingMessage.textContent = "Installing R packages…";
  await window.webR.evalRVoid(
    `webr::install(c('ordinalMIC','ordinal','dplyr','jsonlite','readr','tibble','ggplot2','svglite'),
       repos=c('https://clstacy.r-universe.dev','https://repo.r-wasm.org/'))`
  );
  await window.webR.evalRVoid(
    "library(ordinalMIC);library(ordinal);library(jsonlite);library(readr);library(dplyr);library(tibble);library(ggplot2);library(svglite)"
  );
  el.loadingStatus.innerHTML =
    '<span class="text-green-600 font-semibold">✔ Ready.</span>';
}

/* ---- data load ---- */
el.csvInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
    complete: (res) =>
      setupData(
        res.data.filter((r) =>
          Object.values(r).some((v) => v !== null && String(v).trim() !== "")
        )
      ),
  });
});
el.exampleBtn.addEventListener("click", async () => {
  el.exampleBtn.disabled = true;
  el.exampleBtn.textContent = "Loading…";
  try {
    const r = await window.webR.evalR(
      "data('yeast_df', package = 'ordinalMIC'); readr::format_csv(yeast_df)"
    );
    const csv = await r.toString();
    Papa.parse(csv, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete: (res) => {
        const d = res.data.filter((r) =>
          Object.values(r).some((v) => v !== null && String(v).trim() !== "")
        );
        setupData(d, true);
      },
    });
  } catch (e) {
    console.error("Failed to load example data:", e);
    alert("Failed to load example data. Check the browser console for details.");
  } finally {
    el.exampleBtn.disabled = false;
    el.exampleBtn.textContent = "Example Data Loaded";
  }
});

function setupData(data, isExample = false) {
  parsedData = data;
  cols = Object.keys(data[0] || {});
  [el.scoreSel, el.concSel, el.fac1Sel, el.fac2Sel].forEach((sel) => {
    sel.innerHTML = "<option value=''>-- select a column --</option>";
    if (sel === el.fac2Sel) {
      sel.insertAdjacentHTML(
        "beforeend",
        `<option value="">-- none (optional) --</option>`
      );
    }
    cols.forEach((c) =>
      sel.insertAdjacentHTML("beforeend", `<option value="${c}">${c}</option>`)
    );
  });
  if (isExample) {
    el.scoreSel.value = "score";
    el.concSel.value = "conc";
    el.fac1Sel.value = "strain";
    el.fac2Sel.value = "treatment";
  } else {
    // Prefer "AssignedScore" (case-insensitive)
    const lc = (s) => String(s || "").toLowerCase();
    const has = (name) => cols.some(c => lc(c) === lc(name));

    if (has("AssignedScore")) {
      el.scoreSel.value = cols.find(c => lc(c) === "assignedscore");
    }

    // Prefer "concentration" then "Concentration"
    if (has("concentration")) {
      el.concSel.value = cols.find(c => lc(c) === "concentration");
    } else if (has("Concentration")) {
      el.concSel.value = cols.find(c => lc(c) === "concentration");
    }
  }
  el.variableSection.classList.remove("hidden");
  el.runBtn.disabled = parsedData.length === 0;

  populateBaselineSelector(el.fac1Sel, el.fac1BaselineContainer, el.fac1BaselineSel);
  populateBaselineSelector(el.fac2Sel, el.fac2BaselineContainer, el.fac2BaselineSel);
  updateFormula();
}

function updateFormula() {
  const p = [];
  if (el.fac1Sel.value) p.push("`" + el.fac1Sel.value + "`");
  if (el.fac2Sel.value) p.push("`" + el.fac2Sel.value + "`");
  const factorPart = p.length > 1 ? p.join(" * ") : p.join("");
  const concPart = el.concSel.value ? "log1p(`" + el.concSel.value + "`)" : "";
  el.rhsInput.value = [concPart, factorPart].filter(Boolean).join(" + ");
  el.availVars.textContent = cols.map((c) => "`" + c + "`").join(", ");
}
[el.scoreSel, el.concSel, el.linkSel, el.fac1BaselineSel, el.fac2BaselineSel].forEach(
  (s) => s.addEventListener("change", updateFormula)
);
el.fac1Sel.addEventListener("change", () => {
  populateBaselineSelector(el.fac1Sel, el.fac1BaselineContainer, el.fac1BaselineSel);
  updateFormula();
});
el.fac2Sel.addEventListener("change", () => {
  populateBaselineSelector(el.fac2Sel, el.fac2BaselineContainer, el.fac2BaselineSel);
  updateFormula();
});

async function generatePlot() {
  if (!analysisDone) { el.plotDiv.textContent = "Run analysis first."; return; }
  el.plotDiv.innerHTML = "";
  const type = el.plotTypeSel.value;

  // show a quick spinner while we fetch (first time only)
  showSpinner(el.plotDiv, "Rendering plot…");
  try {
    const svg = await getPlotSVG(type);
    if (!svg) {
      el.plotDiv.innerHTML = '<div class="text-gray-500 p-3">Plot not available for this model.</div>';
      return;
    }
    renderSVG(svg);
  } catch (err) {
    console.error("Plotting error:", err);
    el.plotDiv.innerHTML = `<div class="text-red-600 p-4">Plotting error: ${err.message}</div>`;
  }
}

el.plotTypeSel.addEventListener("change", generatePlot);

/* ---- downloads ---- */
function setupDownloadListeners() {
  if (!last || !analysisDone) return;
  $("download-summary-coeffs").onclick = () =>
    downloadCSV(last.model_summary.coefficients, "model_coefficients.csv");
  $("download-summary-thresholds").onclick = () =>
    downloadCSV(last.model_summary.thresholds, "model_thresholds.csv");
  $("download-mic").onclick = () => downloadCSV(last.mics, "mic_estimates.csv");
  $("download-delta-mic").onclick = () =>
    downloadCSV(last.delta_mics, "delta_mic.csv");
  $("download-ratio-mic").onclick = () =>
    downloadCSV(last.ratio_mics, "ratio_mic.csv");
}

function arrayToSheet(arr) {
  return (!arr || !arr.length)
    ? XLSX.utils.aoa_to_sheet([["(no data)"]])
    : XLSX.utils.json_to_sheet(arr);
}

function buildWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, arrayToSheet(last.mics),        "MIC");
  XLSX.utils.book_append_sheet(wb, arrayToSheet(last.delta_mics),  "DeltaMIC");
  XLSX.utils.book_append_sheet(wb, arrayToSheet(last.ratio_mics),  "RatioMIC");
  XLSX.utils.book_append_sheet(wb, arrayToSheet(last.dod_ratio),   "DoD_Ratio");
  XLSX.utils.book_append_sheet(wb, arrayToSheet(last.dod_delta),   "DoD_Delta");
  XLSX.utils.book_append_sheet(wb, arrayToSheet(last.model_summary?.coefficients || []), "Coefficients");
  XLSX.utils.book_append_sheet(wb, arrayToSheet(last.model_summary?.thresholds   || []), "Thresholds");
  return wb;
}

function buildRmdText(params, fileMap, tfCode, invCode, useShareAny) {
  const { score, conc, link, rhs, fac1, fac2, base1, base2 } = params;
  const dataFile  = fileMap.analysisDataRel;
  const excelFile = fileMap.tablesRel;

  const facLines = [];
  if (fac1) {
    facLines.push(
      base1
        ? `if ("${fac1}" %in% names(df)) df[['${fac1}']] <- stats::relevel(as.factor(df[['${fac1}']]), ref='${base1}')`
        : `if ("${fac1}" %in% names(df)) df[['${fac1}']] <- as.factor(df[['${fac1}']])`
    );
  }
  if (fac2) {
    facLines.push(
      base2
        ? `if ("${fac2}" %in% names(df)) df[['${fac2}']] <- stats::relevel(as.factor(df[['${fac2}']]), ref='${base2}')`
        : `if ("${fac2}" %in% names(df)) df[['${fac2}']] <- as.factor(df[['${fac2}']])`
    );
  }
  const factorLines = facLines.join("\n");

  return `---
title: "Ordinal MIC Analysis"
output: html_document
editor_options:
  chunk_output_type: console
---

> This report was auto-generated by the web app. It uses the exact cleaned data and model settings.

## Setup

\`\`\`r
pkgs <- c("ordinalMIC","ordinal","ggplot2","readr","dplyr","tibble")
to_install <- setdiff(pkgs, rownames(installed.packages()))
if (length(to_install)) install.packages(to_install)
invisible(lapply(pkgs, library, character.only = TRUE))
\`\`\`

## Data (exact data used by the model)

\`\`\`r
df <- readr::read_csv("${dataFile}", show_col_types = FALSE)
str(df)
\`\`\`

## Model

\`\`\`r
${factorLines}

# Ordinal DV and numeric concentration
df[['${score}']] <- ordered(df[['${score}']])
df[['${conc}']]  <- suppressWarnings(readr::parse_number(as.character(df[['${conc}']])))

form <- as.formula(${JSON.stringify("`" + score + "` ~ " + rhs)})
fit <- ordinal::clm(form, data = df, link = "${link}", Hess = TRUE)
summary(fit)
\`\`\`

## MIC Analysis

\`\`\`r
tf  <- ${tfCode}
inv <- ${invCode}
mic <- ordinalMIC::mic_solve(
  fit,
  conc_name = "${conc}",
  transform_fun = tf,
  inv_transform_fun = inv${useShareAny ? ", compare_pairs = 'share_any'" : ""}
)

mic_est   <- tibble::as_tibble(if (!is.null(mic$mic_estimates)) mic$mic_estimates else tibble::tibble())
ratio_out <- tibble::as_tibble(if (!is.null(mic$ratio_mic_results)) mic$ratio_mic_results else tibble::tibble())
delta_out <- tibble::as_tibble(if (!is.null(mic$delta_mic_results)) mic$delta_mic_results else tibble::tibble())
dodR_out  <- tibble::as_tibble(if (!is.null(mic$dod_ratio_results)) mic$dod_ratio_results else tibble::tibble())
dodD_out  <- tibble::as_tibble(if (!is.null(mic$dod_delta_results)) mic$dod_delta_results else tibble::tibble())

mic_est
ratio_out
delta_out
dodR_out
dodD_out
\`\`\`

## Plots

\`\`\`r
library(ggplot2)
autoplot(mic, type="mic")
if (nrow(ratio_out)>0) autoplot(mic, type="ratio")
if (nrow(delta_out)>0) autoplot(mic, type="delta")
if (nrow(dodR_out )>0) autoplot(mic, type="DoD_ratio")
if (nrow(dodD_out )>0) autoplot(mic, type="DoD_delta")
\`\`\`

## Export tables (optional)

\`\`\`r
# Write a single Excel if 'writexl' is available, else CSVs.
if (requireNamespace("writexl", quietly = TRUE)) {
  dir.create("results", showWarnings = FALSE)
  writexl::write_xlsx(list(
    MIC        = mic_est,
    DeltaMIC   = delta_out,
    RatioMIC   = ratio_out,
    DoD_Ratio  = dodR_out,
    DoD_Delta  = dodD_out
  ), path = "${excelFile}")
} else {
  dir.create("results", showWarnings = FALSE)
  readr::write_csv(mic_est,  "results/MIC.csv")
  readr::write_csv(delta_out,"results/DeltaMIC.csv")
  readr::write_csv(ratio_out,"results/RatioMIC.csv")
  readr::write_csv(dodR_out, "results/DoD_Ratio.csv")
  readr::write_csv(dodD_out, "results/DoD_Delta.csv")
}
\`\`\`

## Diagnostics

\`\`\`r
ordinal::nominal_test(fit)
sessionInfo()
\`\`\`
`;
}

function buildReadmeText(params) {
  return `Reproducible bundle

Contents
--------
- data/raw_input.csv          : the dataset you uploaded (cleaned of empty rows)
- data/analysis_data.csv      : the exact data used by the model in R
- results/tables.xlsx         : MIC, DeltaMIC, RatioMIC, DoD_Ratio, DoD_Delta, plus Coefficients and Thresholds
- analysis.Rmd                : R Markdown that reproduces model, plots and tables
- reproduce.R                 : convenience script to render the Rmd

How to run
----------
1) Open R (or RStudio) in this folder.
2) Run:

   source("reproduce.R")

This will install any missing packages and render analysis.Rmd to HTML.

Notes
-----
- analysis_data.csv matches the in-app model after NA removal and factor releveling.
- If writexl is not installed, analysis.Rmd will write CSVs instead of an XLSX.
`;
}

function buildReproduceR() {
  return `pkgs <- c("ordinalMIC","ordinal","ggplot2","readr","dplyr","tibble","rmarkdown")
to_install <- setdiff(pkgs, rownames(installed.packages()))
if (length(to_install)) install.packages(to_install)
rmarkdown::render("analysis.Rmd", output_format = "html_document")`;
}

async function downloadBundle() {
  if (!analysisDone || !last) {
    alert("Run the analysis first.");
    return;
  }
  try {
    const zip = new JSZip();

    // 1) Data files
    const rawCsv = Papa.unparse(parsedData);
    zip.file("data/raw_input.csv", rawCsv);
    const usedCsv = last.df_used_csv || Papa.unparse(parsedData);
    zip.file("data/analysis_data.csv", usedCsv);

    // 2) Results workbook (multi-sheet Excel) built in JS
    const wb = buildWorkbook();
    const wbOut = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    zip.file("results/tables.xlsx", new Blob([wbOut], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));

    // 3) R Markdown (+ helper files)
    const params = {
      score: el.scoreSel.value,
      conc:  el.concSel.value,
      link:  el.linkSel.value,
      rhs:   el.rhsInput.value.trim(),
      fac1:  el.fac1Sel.value,
      fac2:  el.fac2Sel.value,
      base1: el.fac1BaselineSel.value,
      base2: el.fac2BaselineSel.value,
    };
    const fileMap = {
      analysisDataRel: "data/analysis_data.csv",
      tablesRel:       "results/tables.xlsx",
    };
    
    const { tf: TF_CODE_RMD, inv: INV_CODE_RMD } = pickTransform(params.rhs, params.conc);

    const rmd = buildRmdText(params, fileMap, TF_CODE_RMD, INV_CODE_RMD, !!(el.filterPairs?.checked));
    zip.file("analysis.Rmd", rmd);

    const readme = buildReadmeText(params);
    zip.file("README.txt", readme);

    const repro = buildReproduceR();
    zip.file("reproduce.R", repro);

    // 4) Session info
    if (last.session_info) zip.file("sessionInfo.txt", last.session_info);

    // 5) Plots as standalone SVGs (optional)
    const keys = ["mic","ratio","delta","dod_ratio","dod_delta"];
    for (const k of keys) {
      if (last.available_plots && last.available_plots[k]) {
        const svg = await getPlotSVG(k); // cached or freshly rendered from R
        if (svg && svg.length > 20) {
          zip.file(`results/plot_${k}.svg`, sanitizeSVGForFile(svg));
        }
      }
    }

    // Ship it (renamed to "Download Results")
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    saveAs(blob, "analysis_results.zip");
  } catch (e) {
    console.error("Bundle build failed:", e);
    alert("Failed to build the results ZIP. See console for details.");
  }
}

/* ---- run ---- */
el.runBtn.addEventListener("click", async () => {
  if (!parsedData || parsedData.length === 0) {
    alert("No data loaded.");
    return;
  }
  el.runBtn.disabled = true;
  document.getElementById("download-bundle")?.setAttribute("disabled","disabled");
  el.runBtn.innerHTML = `<div class="flex items-center justify-center"><div class="spinner w-5 h-5 border-4 border-gray-200 rounded-full mr-3"></div><span>Running...</span></div>`;
  el.resultsSection.classList.add("hidden");
  el.errorBox.classList.add("hidden");
  analysisDone = false;

  ["modelSummary", "micTable", "deltaTable", "ratioTable", "dodRatioTable", "dodDeltaTable", "diagText"].forEach(
    (k) => showSpinner(el[k], "Running analysis...")
  );
  showSpinner(el.plotDiv, "Awaiting analysis results...");

  const params = {
    score: el.scoreSel.value,
    conc: el.concSel.value,
    link: el.linkSel.value,
    rhs: el.rhsInput.value.trim(),
    fac1: el.fac1Sel.value,
    fac2: el.fac2Sel.value,
    base1: el.fac1BaselineSel.value,
    base2: el.fac2BaselineSel.value,
  };
  const { score, conc, link, rhs, fac1, fac2, base1, base2 } = params;
  if (!score || !conc || !rhs) {
    alert("Please select Score, Concentration, and at least one Factor variable.");
    el.runBtn.disabled = false;
    el.runBtn.textContent = "Run Analysis";
    return;
  }
  const { tf: TF_CODE, inv: INV_CODE } = pickTransform(rhs, conc);
  const cmpArg = el.filterPairs?.checked ? ", compare_pairs = 'share_any'" : "";

  const rCode = `
    tryCatch({
      df <- jsonlite::fromJSON(${JSON.stringify(JSON.stringify(parsedData))})

      factor_info <- list(
        list(name = ${fac1 ? JSON.stringify(fac1) : "NULL"}, baseline = ${base1 ? JSON.stringify(base1) : "NULL"}),
        list(name = ${fac2 ? JSON.stringify(fac2) : "NULL"}, baseline = ${base2 ? JSON.stringify(base2) : "NULL"})
      )
      for (info in factor_info) {
        col_name <- info$name
        baseline <- info$baseline
        if (!is.null(col_name) && col_name %in% names(df)) {
          df[[col_name]] <- as.factor(df[[col_name]])
          ref_level <- if (!is.null(baseline) && baseline %in% levels(df[[col_name]])) baseline else levels(df[[col_name]])[1]
          df[[col_name]] <- stats::relevel(df[[col_name]], ref = ref_level)
        }
      }

      safe_rename <- function(df, map) {
        if (is.null(df) || !is.data.frame(df)) return(df)
        nm <- names(df); if (is.null(nm)) return(df)
        for (k in names(map)) {
          i <- which(nm == k)
          if (length(i)) nm[i] <- map[[k]]
        }
        names(df) <- nm
        df
      }
      to_tbl <- function(x) if (is.null(x)) tibble::tibble() else tibble::as_tibble(x)

      # clean NA & types
      df <- stats::na.omit(df)
      if (nrow(df) == 0) stop("All data was removed after cleaning missing values.")

      df[[${JSON.stringify(score)}]] <- ordered(df[[${JSON.stringify(score)}]])
      df[[${JSON.stringify(conc)}]]  <- suppressWarnings(readr::parse_number(as.character(df[[${JSON.stringify(conc)}]])))
      
      # keep a CSV of the *exact* data used in modeling
      df_used_csv <- readr::format_csv(df)
      
      # capture session info for reproducibility
      session_info <- paste(capture.output(utils::sessionInfo()), collapse="\\n")

      # fit
      formula_str <- stats::as.formula(${JSON.stringify("`" + score + "` ~ " + rhs)})
      model <- ordinal::clm(formula_str, data = df, link = ${JSON.stringify(link)}, Hess = TRUE)
      mic_analysis <- ordinalMIC::mic_solve(
        model,
        conc_name = ${JSON.stringify(conc)},
        transform_fun = ${TF_CODE},
        inv_transform_fun = ${INV_CODE}${cmpArg}
      )

      s <- summary(model)

      # mic
      mic_df <- safe_rename(mic_analysis$mic_estimates,
                            c(mic = "MIC", MIC = "MIC",
                              lower_ci = "CI_Lower", upper_ci = "CI_Upper"))

      # ratio
      ratio_df <- to_tbl(mic_analysis$ratio_mic_results)
      if (nrow(ratio_df)) {
        ratio_df <- safe_rename(ratio_df, c(mic_ratio="Ratio_MIC", MIC_Ratio="Ratio_MIC",
                                            lower_ci="CI_Lower", upper_ci="CI_Upper"))
      }

      # delta
      delta_df <- to_tbl(mic_analysis$delta_mic_results)
      if (nrow(delta_df)) {
        delta_df <- safe_rename(delta_df, c(
          delta_mic="Delta_MIC", DeltaMIC="Delta_MIC", delta="Delta_MIC",
          lower_ci="CI_Lower", upper_ci="CI_Upper", lcl="CI_Lower", ucl="CI_Upper"
        ))
      }

      # DoD ratio
      dod_ratio_df <- to_tbl(mic_analysis$dod_ratio_results)
      if (nrow(dod_ratio_df)) {
        dod_ratio_df <- safe_rename(dod_ratio_df, c(p="P_value", P="P_value", p_value="P_value"))
        if (!"label" %in% names(dod_ratio_df)) {
          if (all(c("var1","var2","var1_lvlA","var1_lvlB","var2_lvlC","var2_lvlD") %in% names(dod_ratio_df))) {
            dod_ratio_df$label <- sprintf("%s: %s vs %s × %s: %s vs %s",
              dod_ratio_df$var1, dod_ratio_df$var1_lvlB, dod_ratio_df$var1_lvlA,
              dod_ratio_df$var2, dod_ratio_df$var2_lvlD, dod_ratio_df$var2_lvlC)
          } else if ("Comparison" %in% names(dod_ratio_df)) {
            dod_ratio_df$label <- dod_ratio_df$Comparison
          } else if ("contrast" %in% names(dod_ratio_df)) {
            dod_ratio_df$label <- dod_ratio_df$contrast
          } else {
            dod_ratio_df$label <- "Difference-of-Differences"
          }
        }
        if ("DDlog2MIC" %in% names(dod_ratio_df)) {
          dod_ratio_df$log2Estimate <- as.numeric(dod_ratio_df$DDlog2MIC)
          dod_ratio_df$Estimate     <- 2^as.numeric(dod_ratio_df$DDlog2MIC)
        } else if ("Estimate" %in% names(dod_ratio_df)) {
          dod_ratio_df$Estimate     <- as.numeric(dod_ratio_df$Estimate)
          dod_ratio_df$log2Estimate <- log2(dod_ratio_df$Estimate)
        }
        if (all(c("CI_Lower","CI_Upper") %in% names(dod_ratio_df))) {
          dod_ratio_df$CI_Lower <- as.numeric(dod_ratio_df$CI_Lower)
          dod_ratio_df$CI_Upper <- as.numeric(dod_ratio_df$CI_Upper)
          dod_ratio_df$log2Lower <- ifelse(dod_ratio_df$CI_Lower > 0, log2(dod_ratio_df$CI_Lower), NA_real_)
          dod_ratio_df$log2Upper <- ifelse(dod_ratio_df$CI_Upper > 0, log2(dod_ratio_df$CI_Upper), NA_real_)
        }
        if ("SE_logDoD" %in% names(dod_ratio_df)) dod_ratio_df$SE_logDoD <- as.numeric(dod_ratio_df$SE_logDoD)
        if ("SE_DoD"    %in% names(dod_ratio_df)) dod_ratio_df$SE_DoD    <- as.numeric(dod_ratio_df$SE_DoD)
        if ("P_value"   %in% names(dod_ratio_df)) dod_ratio_df$P_value   <- as.numeric(dod_ratio_df$P_value)
      }
      dod_ratio_df <- dod_ratio_df %>%
        dplyr::select(-dplyr::any_of(c("var1","var2","var1_lvlA","var1_lvlB","var2_lvlC","var2_lvlD"))) %>%
        dplyr::rename(Comparison = label)

      # DoD delta
      dod_delta_df <- to_tbl(mic_analysis$dod_delta_results)
      if (nrow(dod_delta_df)) {
        dod_delta_df <- safe_rename(dod_delta_df, c(p="P_value", P="P_value", p_value="P_value"))
        if (!"label" %in% names(dod_delta_df)) {
          if (all(c("var1","var2","var1_lvlA","var1_lvlB","var2_lvlC","var2_lvlD") %in% names(dod_delta_df))) {
            dod_delta_df$label <- sprintf("%s: %s vs %s × %s: %s vs %s",
              dod_delta_df$var1, dod_delta_df$var1_lvlB, dod_delta_df$var1_lvlA,
              dod_delta_df$var2, dod_delta_df$var2_lvlD, dod_delta_df$var2_lvlC)
          } else if ("Comparison" %in% names(dod_delta_df)) {
            dod_delta_df$label <- dod_delta_df$Comparison
          } else {
            dod_delta_df$label <- "Difference-of-Differences"
          }
        }
        if ("DDMIC" %in% names(dod_delta_df)) {
          dod_delta_df$Estimate <- as.numeric(dod_delta_df$DDMIC)
        } else if ("Estimate" %in% names(dod_delta_df)) {
          dod_delta_df$Estimate <- as.numeric(dod_delta_df$Estimate)
        }
        if (all(c("CI_Lower","CI_Upper") %in% names(dod_delta_df))) {
          dod_delta_df$CI_Lower <- as.numeric(dod_delta_df$CI_Lower)
          dod_delta_df$CI_Upper <- as.numeric(dod_delta_df$CI_Upper)
        }
        if ("SE_DoD"  %in% names(dod_delta_df)) dod_delta_df$SE_DoD  <- as.numeric(dod_delta_df$SE_DoD)
        if ("P_value" %in% names(dod_delta_df)) dod_delta_df$P_value <- as.numeric(dod_delta_df$P_value)
      }
      dod_delta_df <- dod_delta_df %>%
        dplyr::select(-dplyr::any_of(c("var1","var2","var1_lvlA","var1_lvlB","var2_lvlC","var2_lvlD"))) %>%
        dplyr::rename(Comparison = label)

      # split summary
      coef_mat <- as.data.frame(s$coefficients)
      coef_df  <- tibble::rownames_to_column(coef_mat, "Term")
      thr_flag <- grepl("\\\\|", coef_df$Term)
      thr_df   <- coef_df[thr_flag, ]
      coef_df  <- coef_df[!thr_flag, ]
      
      # ---- persist data for lazy plotting (with cached ggplots) ----
      .GlobalEnv$.mic_env <- new.env(parent = emptyenv())
      .GlobalEnv$.mic_env$mic_analysis <- mic_analysis
      .GlobalEnv$.mic_env$has_ratio    <- nrow(ratio_df)     > 0
      .GlobalEnv$.mic_env$has_delta    <- nrow(delta_df)     > 0
      .GlobalEnv$.mic_env$has_dod_r    <- nrow(dod_ratio_df) > 0
      .GlobalEnv$.mic_env$has_dod_d    <- nrow(dod_delta_df) > 0
      .GlobalEnv$.mic_env$plots        <- list()
      
      .GlobalEnv$.build_plot <- function(type) {
        me <- .GlobalEnv$.mic_env
        ma <- me$mic_analysis
        p <- switch(type,
          "mic"       = autoplot(ma, type = "mic"),
          "ratio"     = if (me$has_ratio)  autoplot(ma, type = "ratio")     else NULL,
          "delta"     = if (me$has_delta)  autoplot(ma, type = "delta")     else NULL,
          "dod_ratio" = if (me$has_dod_r)  autoplot(ma, type = "DoD_ratio") else NULL,
          "dod_delta" = if (me$has_dod_d)  autoplot(ma, type = "DoD_delta") else NULL,
          NULL
        )
        if (is.null(p)) return(NULL)
        p + ggplot2::theme_minimal(base_size = 16) +
            ggplot2::theme(plot.title = ggplot2::element_text(face = "bold"),
                           legend.position = "bottom")
      }
      
      .GlobalEnv$.render_plot_svg <- function(type, w = 11, h = 7, pointsize = 14) {
        me <- .GlobalEnv$.mic_env
        if (is.null(me$plots[[type]])) {
          me$plots[[type]] <- .GlobalEnv$.build_plot(type)
        }
        p <- me$plots[[type]]
        if (is.null(p)) return(NA_character_)
        as.character(
          svglite::stringSVG(code = print(p), width = w, height = h,
                             pointsize = pointsize, standalone = TRUE)
        )
      }
      
      final_list <- list(
        mics           = mic_df,
        ratio_mics     = ratio_df,
        delta_mics     = delta_df,
        dod_ratio      = dod_ratio_df,
        dod_delta      = dod_delta_df,
        model_summary  = list(coefficients = coef_df, thresholds = thr_df),
        available_plots = list(
          mic       = TRUE,
          ratio     = .GlobalEnv$.mic_env$has_ratio,
          delta     = .GlobalEnv$.mic_env$has_delta,
          dod_ratio = .GlobalEnv$.mic_env$has_dod_r,
          dod_delta = .GlobalEnv$.mic_env$has_dod_d
        ),
        df_used_csv    = df_used_csv,
        session_info   = session_info,
        proportional_test = tryCatch(
          paste(capture.output(suppressMessages(ordinal::nominal_test(model))), collapse = "\\n"),
          error = function(e) paste("Nominal test failed:", e$message)
        )
      )
      jsonlite::toJSON(final_list, dataframe = "rows", auto_unbox = TRUE, na = "null")
    })
  `;

  let shel;
  try {
    shel = await new window.webR.Shelter();
    const result = await shel.evalR(rCode);
    let res = await result.toJs();
    if (res.type === "character" && res.values?.length > 0) {
      res = JSON.parse(res.values[0]);
    }
    if (res.error) {
      throw new Error(res.error);
    }

    // ensure Comparison exists and remove label so we don't show extra columns
    ["dod_ratio", "dod_delta"].forEach((k) => {
      (res[k] || []).forEach((row) => {
        if (!row.Comparison) row.Comparison = row.label ?? "Difference-of-Differences";
        delete row.label;
      });
    });

    // numeric coercions
    ["mics", "ratio_mics", "delta_mics", "dod_ratio", "dod_delta"].forEach((k) => {
      (res[k] || []).forEach((row) => {
        ["MIC", "Ratio_MIC", "Delta_MIC", "Estimate", "CI_Lower", "CI_Upper"].forEach(
          (col) => {
            if (row[col] !== undefined && row[col] !== null) row[col] = +row[col];
          }
        );
      });
    });
    
    const dlBtn = document.getElementById("download-bundle");
    if (dlBtn) {
      dlBtn.disabled = false;
      dlBtn.removeAttribute("disabled");
    }
    if (el.sideDownload) {
      el.sideDownload.disabled = false;
      el.sideDownload.classList.remove("opacity-50","pointer-events-none");
    }

    last = res;
    last.df_used_csv = res.df_used_csv || "";
    last.session_info = res.session_info || "";
    
    analysisDone = true;
    
    const can = last.available_plots || {};
    const byId = (id) => document.getElementById(id);
    
    byId("plot-opt-mic").disabled        = !can.mic;
    byId("plot-opt-ratio").disabled      = !can.ratio;
    byId("plot-opt-delta").disabled      = !can.delta;
    byId("plot-opt-dod-ratio").disabled  = !can.dod_ratio;
    byId("plot-opt-dod-delta").disabled  = !can.dod_delta;
    
    // choose a sensible default
    const pref = ["mic","ratio","delta","dod_ratio","dod_delta"].find(k => can[k]);
    if (pref) el.plotTypeSel.value = pref;
    
    // kick off the first render (lazy)
    generatePlot();

    groupCols = detectGroupColsFromMics(last.mics);

    // UI render
    el.resultsSection.classList.remove("hidden");
    renderModelSummary(el.modelSummary, last.model_summary);
    renderTable(el.micTable, last.mics, "No MIC estimates were generated.");

    el.pairwiseBlock.classList.toggle("hidden", !last.ratio_mics?.length && !last.delta_mics?.length);
    if (last.delta_mics?.length) {
      renderTable(el.deltaTable, last.delta_mics, "No additive comparisons generated.");
    }
    if (last.ratio_mics?.length) {
      renderTable(el.ratioTable, last.ratio_mics, "No ratio comparisons generated.");
    }

    el.dodBlock.classList.toggle("hidden", !last.dod_ratio?.length && !last.dod_delta?.length);
    if (last.dod_ratio?.length) {
      renderTable(
        el.dodRatioTable,
        projectColumns(last.dod_ratio, [
          "Comparison",
          "DDlog2MIC",
          "SE_logDoD",
          "CI_Lower",
          "CI_Upper",
          "P_value",
        ]),
        "No ratio DoD results."
      );
    }
    if (last.dod_delta?.length) {
      renderTable(
        el.dodDeltaTable,
        projectColumns(last.dod_delta, [
          "Comparison",
          "DDMIC",
          "SE_DoD",
          "CI_Lower",
          "CI_Upper",
          "P_value",
        ]),
        "No additive DoD results (not typically generated)."
      );
    }

    el.diagText.textContent =
      last.proportional_test || "Test not performed or failed.";

    setupDownloadListeners();
  } catch (e) {
    el.errorBox.classList.remove("hidden");
    el.errorMsg.textContent = e.message;
    console.error("ANALYSIS FAILED in JavaScript:", e);
  } finally {
    if (shel) await shel.purge();
    el.runBtn.disabled = false;
    el.runBtn.textContent = "Run Analysis";
  }
});

el.resetBtn?.addEventListener("click", resetApp);

document.addEventListener("DOMContentLoaded", () => {
  initWebR();
  const dl = document.getElementById("download-bundle");
  if (dl) dl.addEventListener("click", downloadBundle);
  el.sideDownload?.addEventListener("click", downloadBundle);
});
