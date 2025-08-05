import * as Plot from "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/+esm";
import { WebR } from "https://webr.r-wasm.org/v0.4.3/webr.mjs";

/* ---- element look‑ups ---- */
const $ = id => document.getElementById(id);
const el = {
    loadingStatus: $("loading-status"), loadingMessage: $("loading-message"), runBtn: $("run-analysis-button"),
    csvInput: $("csv-file-input"), exampleBtn: $("load-example-button"), variableSection: $("variable-mapping-section"),
    resultsSection: $("results-section"), errorBox: $("error-output"), errorMsg: $("error-message"),
    scoreSel: $("score-var-select"), concSel: $("concentration-var-select"), fac1Sel: $("factor1-var-select"),
    fac2Sel: $("factor2-var-select"), linkSel: $("link-function-select"), rhsInput: $("model-formula-rhs-input"),
    availVars: $("available-vars-formula"), plotTypeSel: $("plot-type-select"), plotHelp: $("plot-help-text"),
    plotDiv: $("plot-output-div"), modelSummary: $("model-summary-content"), micTable: $("mic-table-content"),
    pairwiseBlock: $("pairwise-mic-output"), deltaTable: $("delta-mic-table-content"), ratioTable: $("ratio-mic-table-content"),
    dodBlock: $("dod-output"), dodRatioTable: $("dod-ratio-mic-table-content"), dodDeltaTable: $("dod-delta-mic-table-content"),
    diagText: $("diagnostics-test-content")
};

/* ---- state ---- */
let parsedData = [], cols = [], last = {}, analysisDone = false;

/* ---- helpers ---- */
const showSpinner = (node, msg) => { node.innerHTML = `<div class="flex flex-col items-center justify-center text-gray-500 h-full p-4"><div class="spinner w-8 h-8 border-4 border-gray-200 rounded-full mb-2"></div><p>${msg}</p></div>`; };
function numFmt(x, dec = 3) { return (typeof x === "number" && isFinite(x)) ? x.toFixed(dec) : String(x) }
function renderTable(element, data, noDataMsg = "No data available.") { if (!data || data.length === 0) { element.innerHTML = `<p class="text-gray-500 text-sm">${noDataMsg}</p>`; return; } const headers = Object.keys(data[0]); const headHTML = headers.map(h => `<th class="p-2 border-b text-left text-sm font-semibold text-gray-600 bg-gray-50">${h}</th>`).join(''); const bodyHTML = data.map(row => `<tr>${headers.map(h => `<td class="p-2 border-b text-sm font-mono">${numFmt(row[h])}</td>`).join('')}</tr>`).join(''); element.innerHTML = `<div class="overflow-x-auto"><table class="w-full border-collapse"><thead><tr>${headHTML}</tr></thead><tbody>${bodyHTML}</tbody></table></div>`; }
function renderModelSummary (element, summary) {
  if (!summary || !Array.isArray(summary.coefficients) || !Array.isArray(summary.thresholds)) { element.innerHTML = "<p class='text-gray-500 text-sm'>Model summary unavailable.</p>"; return; }
  const makeHtml = (title, rows) => {
    if (!rows || rows.length === 0) { return `<h5 class="font-medium mt-4 mb-1 text-gray-700">${title}</h5><p class="text-gray-500 text-sm">No data available.</p>`; }
    const heads = Object.keys(rows[0]);
    const thead = heads.map(h => `<th class="p-2 border-b text-left text-xs font-bold text-gray-600 bg-gray-50">${h}</th>`).join("");
    const tbody = rows.map(r => `<tr>${heads.map(h => `<td class="p-2 border-b text-xs font-mono">${numFmt(r[h])}</td>`).join("")}</tr>`).join("");
    return `<h5 class="font-medium mt-4 mb-1 text-gray-700">${title}</h5><div class="overflow-x-auto"><table class="w-full border-collapse"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
  };
  element.innerHTML = makeHtml("Coefficients", summary.coefficients) + makeHtml("Thresholds (Cut-points)", summary.thresholds);
}
function downloadCSV(data, filename) { if (!data || data.length === 0) { alert("No data available to download."); return; } const csv = Papa.unparse(data); const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' }); const link = document.createElement("a"); const url = URL.createObjectURL(blob); link.setAttribute("href", url); link.setAttribute("download", filename); link.style.visibility = 'hidden'; document.body.appendChild(link); link.click(); document.body.removeChild(link); }

async function initWebR() { el.loadingMessage.textContent = "Initializing webR core…"; window.webR = new WebR({ captureStreams: true }); await window.webR.init(); el.loadingMessage.textContent = "Installing R packages…"; await window.webR.evalRVoid(`webr::install(c('ordinalMIC','ordinal','dplyr','jsonlite','readr','tibble'), repos=c('https://clstacy.r-universe.dev','https://repo.r-wasm.org/'))`); await window.webR.evalRVoid("library(ordinalMIC);library(ordinal);library(jsonlite);library(readr);library(dplyr);library(tibble)"); el.loadingStatus.innerHTML = '<span class="text-green-600 font-semibold">✔ Ready.</span>'; }
el.csvInput.addEventListener("change", e => { const file = e.target.files[0]; if (!file) return; Papa.parse(file, { header: true, skipEmptyLines: true, dynamicTyping: true, complete: res => setupData(res.data.filter(r => Object.values(r).some(v => v !== null && String(v).trim() !== ""))) }); });
el.exampleBtn.addEventListener("click", async () => { el.exampleBtn.disabled = true; el.exampleBtn.textContent = "Loading…"; try { const r = await window.webR.evalR("data('yeast_df', package = 'ordinalMIC'); readr::format_csv(yeast_df)"); const csv = await r.toString(); Papa.parse(csv, { header: true, skipEmptyLines: true, dynamicTyping: true, complete: res => { const d = res.data.filter(r => Object.values(r).some(v => v !== null && String(v).trim() !== "")); setupData(d, true); } }); } catch (e) { console.error("Failed to load example data:", e); alert("Failed to load example data. Check the browser console for details."); } finally { el.exampleBtn.disabled = false; el.exampleBtn.textContent = "Example Data Loaded"; } });
function setupData(data, isExample = false) { parsedData = data; cols = Object.keys(data[0]); [el.scoreSel, el.concSel, el.fac1Sel, el.fac2Sel].forEach(sel => { sel.innerHTML = "<option value=''>-- select a column --</option>"; if (sel === el.fac2Sel) { sel.insertAdjacentHTML("beforeend", `<option value="">-- none (optional) --</option>`); } cols.forEach(c => sel.insertAdjacentHTML("beforeend", `<option value="${c}">${c}</option>`)); }); if (isExample) { el.scoreSel.value = "score"; el.concSel.value = "conc"; el.fac1Sel.value = "strain"; el.fac2Sel.value = "treatment"; } el.variableSection.classList.remove("hidden"); el.runBtn.disabled = parsedData.length === 0; updateFormula(); }
function updateFormula() { const p = []; if (el.fac1Sel.value) p.push('`' + el.fac1Sel.value + '`'); if (el.fac2Sel.value) p.push('`' + el.fac2Sel.value + '`'); const factorPart = p.length > 1 ? p.join(" * ") : p.join(""); const concPart = el.concSel.value ? 'log1p(`' + el.concSel.value + '`)' : ''; el.rhsInput.value = [concPart, factorPart].filter(Boolean).join(" + "); el.availVars.textContent = cols.map(c => '`' + c + '`').join(', '); }
[el.scoreSel, el.concSel, el.fac1Sel, el.fac2Sel, el.linkSel].forEach(s => s.addEventListener("change", updateFormula));

// --- generatePlot FUNCTION ---
function generatePlot() {
  if (!analysisDone) { el.plotDiv.textContent = "Run analysis first."; return; }
  el.plotDiv.innerHTML = "";
  const type = el.plotTypeSel.value;
  let plot;

  try {
    if (type === "mic") {
      const data = last.mics;
      if (!data?.length) throw new Error("no MIC data");
      const y = d => `${d.strain} : ${d.treatment}`;
      const yDomain = data.map(y).sort();
      
      plot = Plot.plot({
        title: "Model-estimated MIC (95% CI)",
        height: yDomain.length * 45 + 100, // Dynamic height for better spacing
        marginLeft: 180,
        y: { domain: yDomain, label: null },
        x: { grid: true, label: "MIC (Concentration)" }, // Linear scale for MIC
        marks: [
          // Use barX for HORIZONTAL bars
          Plot.barX(data, { y, x: "MIC", fill: "#ccc", fillOpacity: 0.6 }),
          // Use ruleX for HORIZONTAL confidence intervals
          Plot.ruleX(data, { y, x1: "CI_Lower", x2: "CI_Upper", strokeWidth: 2, stroke: "black" }),
          Plot.tip(data, Plot.pointerX({ x: "MIC", y, title: d => `${y(d)}\nMIC: ${numFmt(d.MIC)}\n95% CI: [${numFmt(d.CI_Lower)}, ${numFmt(d.CI_Upper)}]` }))
        ]
      });

    } else if (type === "ratio") {
      const data = last.ratio_mics;
      if (!data?.length) throw new Error("no Ratio MIC data");
      
      // Pre-calculate log2 values for a linear plot axis
      const plotData = data.map(d => ({
        ...d,
        yLabel: `${d.Group2} / ${d.Group1}`,
        log2Ratio: Math.log2(d.Ratio_MIC),
        log2Lower: Math.log2(d.CI_Lower),
        log2Upper: Math.log2(d.CI_Upper),
      }));
      const yDomain = plotData.map(d => d.yLabel).sort().reverse();

      plot = Plot.plot({
        title: "Pairwise MIC Ratios",
        height: yDomain.length * 40 + 100,
        marginLeft: 250,
        y: { domain: yDomain, label: null },
        x: { grid: true, label: "log₂(MIC Ratio)", zero: true }, // Linear scale of log2 values
        marks: [
          Plot.ruleX([0], { strokeDasharray: "4,4", stroke: "red" }), // Reference line at 0 (since log2(1) = 0)
          Plot.barX(plotData, { y: "yLabel", x: "log2Ratio", fill: "orange", fillOpacity: 0.4 }),
          Plot.ruleX(plotData, { y: "yLabel", x1: "log2Lower", x2: "log2Upper", strokeWidth: 2, stroke: "black" }),
          Plot.tip(plotData, Plot.pointerX({ x: "log2Ratio", y: "yLabel", title: d => `${d.yLabel}\nRatio: ${numFmt(d.Ratio_MIC)}\n95% CI: [${numFmt(d.CI_Lower)}, ${numFmt(d.CI_Upper)}]` }))
        ]
      });

    } else if (type === "dod_ratio") {
      const data = last.dod_ratio;
      if (!data?.length) throw new Error("no DoD data");
        
      const plotData = data.map(d => ({
        ...d,
        log2Estimate: Math.log2(d.Estimate),
        log2Lower: Math.log2(d.CI_Lower),
        log2Upper: Math.log2(d.CI_Upper),
      }));
        
      plot = Plot.plot({
        title: "Difference-of-Differences (Ratio Scale)",
        height: data.length * 50 + 100,
        marginLeft: 260,
        y: { domain: plotData.map(d => d.label).reverse(), label: null },
        x: { grid: true, label: "log₂(DoD Estimate)", zero: true }, // Linear scale of log2 values
        marks: [
          Plot.ruleX([0], { strokeDasharray: "4,4", stroke: "red" }),
          Plot.barX(plotData, { y: "label", x: "log2Estimate", fill: "green", fillOpacity: 0.4 }),
          Plot.ruleX(plotData, { y: "label", x1: "log2Lower", x2: "log2Upper", strokeWidth: 2, stroke: "black" }),
          Plot.tip(plotData, Plot.pointerX({ x: "log2Estimate", y: "label", title: d => `${d.label}\nDoD: ${numFmt(d.Estimate)}\n95% CI: [${numFmt(d.CI_Lower)}, ${numFmt(d.CI_Upper)}]` }))
        ]
      });
    }

    if (plot) el.plotDiv.append(plot);

  } catch (err) {
    console.error("Plotting Error:", err);
    el.plotDiv.innerHTML = `<div class="text-red-600 p-4">Plotting error: ${err.message}</div>`;
  }
}
el.plotTypeSel.addEventListener("change", generatePlot);

function setupDownloadListeners() {
    if (!last || !analysisDone) return;
    const getCoeffsData = () => Object.entries(last.model_summary.coefficients).map(([term, v]) => ({ Term: term, Estimate: v[0], 'Std. Error': v[1], 'z value': v[2], 'Pr(>|z|)': v[3] }));
    const getThreshData = () => {
        const headers = last.model_summary.condHess ? ['Estimate', 'Std. Error', 'z value'] : ['Estimate', 'Std. Error'];
        return Object.entries(last.model_summary.thresholds).map(([term, values]) => {
            const row = { Term: term };
            headers.forEach((h, i) => { row[h] = values[i]; });
            return row;
        });
    };
    $('download-summary-coeffs').onclick = () => downloadCSV(getCoeffsData(), 'model_coefficients.csv');
    $('download-summary-thresholds').onclick = () => downloadCSV(getThreshData(), 'model_thresholds.csv');
    $('download-mic').onclick = () => downloadCSV(last.mics, 'mic_estimates.csv');
    $('download-delta-mic').onclick = () => downloadCSV(last.delta_mics, 'delta_mic.csv');
    $('download-ratio-mic').onclick = () => downloadCSV(last.ratio_mics, 'ratio_mic.csv');
}

el.runBtn.addEventListener("click", async () => {
    if (!parsedData || parsedData.length === 0) { alert("No data loaded."); return; }
    el.runBtn.disabled = true;
    el.runBtn.innerHTML = `<div class="flex items-center justify-center"><div class="spinner w-5 h-5 border-4 border-gray-200 rounded-full mr-3"></div><span>Running...</span></div>`;
    el.resultsSection.classList.add("hidden");
    el.errorBox.classList.add("hidden");
    analysisDone = false;
    ["modelSummary", "micTable", "deltaTable", "ratioTable", "dodRatioTable", "dodDeltaTable", "diagText"].forEach(k => showSpinner(el[k], "Running analysis..."));
    showSpinner(el.plotDiv, "Awaiting analysis results...");
    const { score, conc, link, rhs } = { score: el.scoreSel.value, conc: el.concSel.value, link: el.linkSel.value, rhs: el.rhsInput.value.trim() };
    if (!score || !conc || !rhs) { alert("Please select Score, Concentration, and at least one Factor variable."); el.runBtn.disabled = false; el.runBtn.textContent = "Run Analysis"; return; }

    const rCode = `
      tryCatch({
        df <- jsonlite::fromJSON(${JSON.stringify(JSON.stringify(parsedData))})
        df <- na.omit(df)
        df[[${JSON.stringify(score)}]] <- ordered(df[[${JSON.stringify(score)}]])
        df[[${JSON.stringify(conc)}]] <- suppressWarnings(readr::parse_number(as.character(df[[${JSON.stringify(conc)}]])))
        formula_str <- as.formula(${JSON.stringify('`' + score + '` ~ ' + rhs)})
        model <- ordinal::clm(formula_str, data=df, link=${JSON.stringify(link)}, Hess=TRUE)
        mic_analysis <- ordinalMIC::mic_solve(model, conc_name=${JSON.stringify(conc)})
        s <- summary(model)
        
        # Using the robust data prep logic you provided
        mic_df <- mic_analysis$mic_estimates
        names(mic_df)[names(mic_df) == "mic"] <- "MIC"
        names(mic_df)[names(mic_df) == "lower_ci"] <- "CI_Lower"
        names(mic_df)[names(mic_df) == "upper_ci"] <- "CI_Upper"

        ratio_df <- mic_analysis$ratio_mic_results
        names(ratio_df)[names(ratio_df) == "ratio_mic"] <- "Ratio_MIC"
        names(ratio_df)[names(ratio_df) == "lower_ci"] <- "CI_Lower"
        names(ratio_df)[names(ratio_df) == "upper_ci"] <- "CI_Upper"

        dod_df <- mic_analysis$dod_ratio_results
        names(dod_df)[names(dod_df) == "estimate"] <- "Estimate"
        names(dod_df)[names(dod_df) == "lower_ci"] <- "CI_Lower"
        names(dod_df)[names(dod_df) == "upper_ci"] <- "CI_Upper"
        
        coef_mat <- as.data.frame(s$coefficients)
        coef_df  <- tibble::rownames_to_column(coef_mat, "Term")
        
        thr_flag <- grepl("\\\\|", coef_df$Term)
        
        thr_df  <- coef_df[thr_flag, ]
        coef_df <- coef_df[!thr_flag, ]

        final_list <- list(
          mics         = mic_df,
          ratio_mics   = ratio_df,
          dod_ratio    = dod_df,
          delta_mics   = mic_analysis$delta_mic_results,
          dod_delta    = mic_analysis$dod_delta_results,
          model_summary = list(coefficients = coef_df, thresholds = thr_df),
          proportional_test = tryCatch(paste(capture.output(suppressMessages(ordinal::nominal_test(model))), collapse = "\\n"), error = function(e) paste("Nominal test failed:", e$message))
        )
        jsonlite::toJSON(final_list, dataframe = "rows", auto_unbox = TRUE, na = "null")
      }, error=function(e) {
        jsonlite::toJSON(list(error=paste("R Error:", as.character(e))), auto_unbox=TRUE)
      })
    `;

    let shel;
    try {
        shel = await new window.webR.Shelter();
        const result = await shel.evalR(rCode);
        let res = await result.toJs();
        if (res.type === 'character' && res.values?.length > 0) { res = JSON.parse(res.values[0]); }
        if (res.error) { throw new Error(res.error); }
        
        // Data type coercion loop
        ["mics","ratio_mics","delta_mics","dod_ratio","dod_delta"].forEach(k=>{
          (res[k]||[]).forEach(row=>{
            ["MIC","Ratio_MIC","Delta_MIC","Estimate","CI_Lower","CI_Upper"].forEach(col=>{
              if (row[col] !== undefined && row[col] !== null)
                row[col] = +row[col];
            });
          });
        });
        
        last = res; 
        analysisDone = true;
        el.resultsSection.classList.remove("hidden");
        setupDownloadListeners = () => {
            if (!last || !analysisDone) return;
            $('download-summary-coeffs').onclick = () => downloadCSV(last.model_summary.coefficients, 'model_coefficients.csv');
            $('download-summary-thresholds').onclick = () => downloadCSV(last.model_summary.thresholds, 'model_thresholds.csv');
            $('download-mic').onclick = () => downloadCSV(last.mics, 'mic_estimates.csv');
            $('download-delta-mic').onclick = () => downloadCSV(last.delta_mics, 'delta_mic.csv');
            $('download-ratio-mic').onclick = () => downloadCSV(last.ratio_mics, 'ratio_mic.csv');
        };
        renderModelSummary(el.modelSummary, last.model_summary);
        renderTable(el.micTable, last.mics, "No MIC estimates were generated.");
        el.pairwiseBlock.classList.toggle("hidden", !last.ratio_mics?.length);
        if (last.ratio_mics?.length) {
            renderTable(el.deltaTable, last.delta_mics, "No additive comparisons generated.");
            renderTable(el.ratioTable, last.ratio_mics, "No ratio comparisons generated.");
        }
        el.dodBlock.classList.toggle("hidden", !last.dod_ratio?.length);
        if (last.dod_ratio?.length) {
            renderTable(el.dodRatioTable, last.dod_ratio, "No ratio DoD results.");
            renderTable(el.dodDeltaTable, last.dod_delta, "No additive DoD results (not typically generated).");
        }
        el.diagText.textContent = last.proportional_test || "Test not performed or failed.";
        $('plot-opt-ratio').disabled = !last.ratio_mics?.length;
        $('plot-opt-dod').disabled = !last.dod_ratio?.length;
        el.plotTypeSel.value = 'mic';
        generatePlot();
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

document.addEventListener("DOMContentLoaded", initWebR);
