import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip,
  PieChart, Pie, Cell, Legend
} from "recharts";

import "./App.css";
import { useEffect, useMemo, useState } from "react";
const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
const ALLOWED_EXTENSIONS = ["pdf", "xlsx", "xls", "csv", "jpg", "jpeg", "png", "zip"];

const SCHEMA_COLUMNS = [
  "deal_id",
  "client_name",
  "deal_value",
  "stage",
  "closing_probability",
  "owner",
  "expected_close_date",
  "source_file",
];

function getExt(filename) {
  const parts = filename.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

function badgeClass(status) {
  if (!status) return "badge";
  if (status === "parsed") return "badge parsed";
  if (status === "ai_extracted") return "badge ai";
  if (status === "expanded") return "badge expanded";
  if (status === "failed") return "badge failed";
  if (status === "rejected") return "badge rejected";
  return "badge";
}

function formatMoney(x) {
  if (x === null || x === undefined || x === "") return "";
  const n = Number(x);
  if (Number.isNaN(n)) return String(x);
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function App() {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const [batchId, setBatchId] = useState(null);
  const [filesResult, setFilesResult] = useState([]);
  const [deals, setDeals] = useState([]);
  const [uploadTimestamp, setUploadTimestamp] = useState(null);
  const [recentBatches, setRecentBatches] = useState([]);
  const [loadingBatches, setLoadingBatches] = useState(false);
  const [kpis, setKpis] = useState(null);
  const [loadingKpis, setLoadingKpis] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    fetchBatches();
  }, []);


  const acceptedHint = useMemo(
    () => ALLOWED_EXTENSIONS.map((e) => "." + e).join(", "),
    []
  );

  function formatBatchLabel(b) {
     const dt = b.latest_upload ? new Date(b.latest_upload) : null;
     const when = dt && !isNaN(dt)
     ? dt.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
     : "Unknown time";

     const n = b.files_count ?? 0;
     const filesText = n === 1 ? "1 file" : `${n} files`;

  // Show a short id for readability
     const short = String(b.batch_id).slice(0, 8);

     return `${when} • ${filesText} • ${short}`;
   }

  function validateFiles(files) {
    const bad = [];
    for (const f of files) {
      const ext = getExt(f.name);
      if (!ALLOWED_EXTENSIONS.includes(ext)) bad.push(f.name);
    }

    return bad;
  }  

  
   const conversionRate = useMemo(() => {
     if (!deals || deals.length === 0) return null;

     const total = deals.length;

     const closedWon = deals.filter(d =>
       (d.stage || "").toLowerCase().includes("won")
     ).length;

     return (closedWon / total) * 100;
   }, [deals]); 

   const stageDist = useMemo(() => {
     const map = new Map();
     for (const d of deals || []) {
      const stage = d.stage || "Unknown";
      map.set(stage, (map.get(stage) || 0) + 1);
     }
    return Array.from(map.entries()).map(([stage, count]) => ({ stage, count }));
   }, [deals]);
 
  function onChooseFiles(e) {
    setError("");
    setBatchId(null);
    setFilesResult([]);
    setDeals([]);
    setUploadTimestamp(null);
    setKpis(null);

    const files = Array.from(e.target.files || []);
    const bad = validateFiles(files);
    if (bad.length) {
      setSelectedFiles([]);
      setError(`Unsupported file type for: ${bad.join(", ")}. Allowed: ${acceptedHint}`);
      return;
    }
    setSelectedFiles(files);
  }

  function onDrop(e) {
   e.preventDefault();
   setDragOver(false);

   const files = Array.from(e.dataTransfer.files || []);
   if (!files.length) return;

   const bad = validateFiles(files);
   if (bad.length) {
     setError(`Unsupported file(s): ${bad.join(", ")}`);
     return;
   }

   setError("");
   setSelectedFiles(files);
 }

 function onDragOver(e) {
   e.preventDefault();
   setDragOver(true);
 }

 function onDragLeave(e) {
   e.preventDefault();
   setDragOver(false);
 }


 

  async function upload() {
    if (!selectedFiles.length) {
      setError("Please choose at least one file.");
      return;
    }

    setError("");
    setUploading(true);
    setProgress(0);
    setBatchId(null);
    setFilesResult([]);
    setDeals([]);
    setUploadTimestamp(null);
    setKpis(null);

    const formData = new FormData();
    for (const f of selectedFiles) formData.append("files", f);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/upload`, true);

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        setProgress(Math.round((evt.loaded / evt.total) * 100));
      }
    };

    xhr.onload = async () => {
      setUploading(false);
      setProgress(100);

      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          setBatchId(data.batch_id);
          setUploadTimestamp(data.upload_timestamp || null);
          setFilesResult(data.files || []);
          setDeals(data.deals_preview || []);
          await fetchKpis(data.batch_id);
          await fetchBatches();
        } else {
          setError(data?.detail || `Upload failed (status ${xhr.status}).`);
        }
      } catch {
        setError(`Upload failed (status ${xhr.status}).`);
      }
    };

    xhr.onerror = () => {
      setUploading(false);
      setError("Network error while uploading. Is the backend running?");
    };

    xhr.send(formData);
  }

  async function refreshAllRecords() {
    if (!batchId) return;
    const res = await fetch(`${API_BASE}/records?batch_id=${batchId}`);
    const data = await res.json();
    setDeals(data.records || []);
    await fetchKpis(batchId);
  }

  


  async function fetchBatches() {
  setLoadingBatches(true);
  try {
    const res = await fetch(`${API_BASE}/batches?limit=20`);
    const data = await res.json();
    setRecentBatches(data.batches || []);
  } finally {
    setLoadingBatches(false);
    }
  }

  async function loadBatch(id) {
  setBatchId(id);
  setKpis(null);
  setDeals([]);
  setFilesResult([]);
  setUploadTimestamp(null);

  // load records
  const rRes = await fetch(`${API_BASE}/records?batch_id=${id}`);
  const rData = await rRes.json();
  setDeals(rData.records || []);

  // load KPIs
  await fetchKpis(id);
  }

  





  async function fetchKpis(id) {
    if (!id) return;
    setLoadingKpis(true);
    try {
      const res = await fetch(`${API_BASE}/kpis?batch_id=${id}`);
      const data = await res.json();
      setKpis(data);
    } finally {
      setLoadingKpis(false);
    }
  }

  function downloadExcel() {
    if (!batchId) return;
    window.location.href = `${API_BASE}/export?batch_id=${batchId}`;
  }

  function renderChildren(children) {
    if (!Array.isArray(children) || children.length === 0) return null;
    return (
      <ul style={{ marginTop: 8 }}>
        {children.map((c, idx) => (
          <li key={idx} className="small">
            <code>{c.source_file}</code>{" "}
            <span className={badgeClass(c.processing_status)}>{c.processing_status}</span>
            {c.error ? <span style={{ color: "salmon" }}> — {c.error}</span> : null}
          </li>
        ))}
      </ul>
    );
  }

  function BarList({ title, items, valueKey, labelKey, formatter }) {
    const max = Math.max(1, ...items.map((i) => Number(i[valueKey] || 0)));
    return (
      <div className="card">
        <div className="label">{title}</div>
        <div style={{ marginTop: 8 }}>
          {items.length === 0 ? (
            <div className="small">No data</div>
          ) : (
            items.slice(0, 8).map((i, idx) => {
              const v = Number(i[valueKey] || 0);
              const pct = Math.round((v / max) * 100);
              return (
                <div className="barRow" key={idx}>
                  <div className="barLabel" title={String(i[labelKey] ?? "")}>
                    {String(i[labelKey] ?? "")}
                  </div>
                  <div className="bar">
                    <div style={{ width: `${pct}%` }} />
                  </div>
                  <div className="small" style={{ width: 92, textAlign: "right" }}>
                    {formatter ? formatter(v) : String(v)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="hero">
        <div>
          <h1>CRM Deals Consolidation</h1>
          <div className="sub">
            Upload HubSpot CSV, Sales Excel, PDF reports, scanned contracts (images), or a ZIP of any mix.
            The system consolidates into the unified schema and lets you export to Excel.
          </div>
        </div>
      </div>

    {/* */}
    <div
      className="panel"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      style={{
        outline: dragOver ? "2px dashed rgba(255,255,255,0.55)" : "none",
        boxShadow: dragOver ? "0 0 0 6px rgba(255,255,255,0.06)" : undefined,
      }}
    >
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div className="small">Recent uploads (saved batches)</div>
          <div className="small" style={{ marginTop: 6 }}>
            Select a previous batch to view its consolidated deals + KPIs + export.
          </div>
        </div>
        <button className="btn" onClick={fetchBatches} disabled={loadingBatches}>
          {loadingBatches ? "Refreshing..." : "Refresh list"}
        </button>
      </div>

      <div style={{ marginTop: 10 }}>
        <select
          className="input"
          onChange={(e) => e.target.value && loadBatch(e.target.value)}
          defaultValue="">
          <option value="">— Select a batch —</option>
          {recentBatches.map((b) => (
            <option key={b.batch_id} value={b.batch_id}>
              {formatBatchLabel(b)}
            </option>
          ))}
        </select>
      </div>
    </div>


      <div
        className="panel"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        style={{
          outline: dragOver ? "2px dashed rgba(255,255,255,0.55)" : "none",
          boxShadow: dragOver ? "0 0 0 6px rgba(255,255,255,0.06)" : undefined,
         }}
      >
        

        <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ flex: 1 }}>
            <div className="small" style={{ marginBottom: 8 }}>
              Allowed: {acceptedHint}
            </div>
            <input
              className="input"
              type="file"
              multiple
              onChange={onChooseFiles}
              accept={acceptedHint}
              disabled={uploading}
            />
          </div>

          <div className="row" style={{ alignItems: "center" }}>
            <button className="btn primary" onClick={upload} disabled={uploading || selectedFiles.length === 0}>
              {uploading ? "Uploading..." : "Upload & Consolidate"}
            </button>
          </div>
        </div>

        {selectedFiles.length > 0 && (
          <div style={{ marginTop: 10 }} className="small">
            <strong>Selected:</strong>{" "}
            {selectedFiles.map((f) => f.name).join(", ")}
          </div>
        )}

        {uploading && (
          <div style={{ marginTop: 12 }}>
            <div className="small" style={{ marginBottom: 6 }}>Progress: {progress}%</div>
            <div className="bar">
              <div style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, color: "salmon" }}>
            <strong>Error:</strong> {error}
          </div>
        )}
      </div>

      {batchId && (
        <div style={{ marginTop: 16 }} className="panel">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div className="small">Batch</div>
              <div style={{ marginTop: 6 }}>
                <code>{batchId}</code>
              </div>
              {uploadTimestamp ? (
                <div className="small" style={{ marginTop: 6 }}>
                  upload_timestamp: <code>{uploadTimestamp}</code>
                </div>
              ) : null}
            </div>

            <div className="row">
              <button className="btn" onClick={refreshAllRecords}>Refresh</button>
              <button className="btn primary" onClick={downloadExcel}>Download Excel</button>
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <div className="small" style={{ marginBottom: 8 }}>File processing status</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {filesResult.map((f, idx) => (
                <li key={idx} style={{ marginBottom: 10 }}>
                  <code>{f.source_file}</code>{" "}
                  <span className={badgeClass(f.processing_status)}>{f.processing_status}</span>
                  {f.error ? <span style={{ color: "salmon" }}> — {f.error}</span> : null}
                  {f.children ? renderChildren(f.children) : null}
                </li>
              ))}
            </ul>
          </div>

          <div style={{ marginTop: 18 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>KPI Dashboard (Optional)</h2>
              <div className="small">{loadingKpis ? "Loading KPIs..." : ""}</div>
            </div>

            <div className="kpis" style={{ marginTop: 10 }}>
              <div className="card">
                <div className="label">Total deals</div>
                <div className="value">{kpis?.total_deals ?? "-"}</div>
              </div>
              <div className="card">
                <div className="label">Total pipeline value</div>
                <div className="value">{kpis ? formatMoney(kpis.total_value) : "-"}</div>
              </div>
              <div className="card">
                <div className="label">Avg closing probability</div>
                <div className="value">{kpis?.avg_probability != null ? `${kpis.avg_probability}%` : "-"}</div>
              </div>
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <div style={{ flex: 1, minWidth: 360 }}>
                <BarList
                  title="Pipeline value by stage"
                  items={kpis?.value_by_stage || []}
                  valueKey="value"
                  labelKey="stage"
                  formatter={(v) => formatMoney(v)}
                />
              </div>
              <div style={{ flex: 1, minWidth: 360 }}>
                <BarList
                  title="Deals by owner"
                  items={kpis?.deals_by_owner || []}
                  valueKey="count"
                  labelKey="owner"
                  formatter={(v) => String(v)}
                />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <BarList
                title="Expected close value by month"
                items={kpis?.value_by_month || []}
                valueKey="value"
                labelKey="month"
                formatter={(v) => formatMoney(v)}
              />
            </div>
          </div>
          
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="h2" style={{ marginBottom: 10 }}>Stage distribution</div>

            {stageDist.length ? (
              <div style={{ width: "100%", height: 280 }}>
      		<ResponsiveContainer>
        	  <BarChart data={stageDist}>
                    <XAxis dataKey="stage" />
          	    <YAxis />
          	    <Tooltip />
          	    <Bar dataKey="count" />
        	  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
           <div className="small">No data</div>
           )}
          </div>

          <div style={{ marginTop: 18 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>Consolidated Deals (Unified Schema)</h2>
            <div className="small" style={{ marginTop: 6 }}>
              Showing preview rows. Use Refresh to load all.
            </div>

            <div className="tableWrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    {SCHEMA_COLUMNS.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {deals.length === 0 ? (
                    <tr><td colSpan={SCHEMA_COLUMNS.length} className="small">No deals yet.</td></tr>
                  ) : (
                    deals.map((r, idx) => (
                      <tr key={idx}>
                        {SCHEMA_COLUMNS.map((k) => (
                          <td key={k}>{k === "deal_value" ? formatMoney(r?.[k]) : (r?.[k] ?? "")}</td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}