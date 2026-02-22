import { useMemo, useState } from "react";

const API_BASE = "http://127.0.0.1:8000";
const ALLOWED_EXTENSIONS = ["pdf", "xlsx", "xls", "csv", "jpg", "jpeg", "png", "zip"];

const SCHEMA_COLUMNS = [
  "deal_id",
  "client_name",
  "deal_value",
  "stage",
  "closing_probability",
  "owner",
  "expected_close_date",
  "source_file", // metadata (useful)
];

function getExt(filename) {
  const parts = filename.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
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

  const acceptedHint = useMemo(
    () => ALLOWED_EXTENSIONS.map((e) => "." + e).join(", "),
    []
  );

  function validateFiles(files) {
    const bad = [];
    for (const f of files) {
      const ext = getExt(f.name);
      if (!ALLOWED_EXTENSIONS.includes(ext)) bad.push(f.name);
    }
    return bad;
  }

  function onChooseFiles(e) {
    setError("");
    setBatchId(null);
    setFilesResult([]);
    setDeals([]);
    setUploadTimestamp(null);

    const files = Array.from(e.target.files || []);
    const bad = validateFiles(files);
    if (bad.length) {
      setSelectedFiles([]);
      setError(`Unsupported file type for: ${bad.join(", ")}. Allowed: ${acceptedHint}`);
      return;
    }
    setSelectedFiles(files);
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

    const formData = new FormData();
    for (const f of selectedFiles) formData.append("files", f);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/upload`, true);

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        setProgress(Math.round((evt.loaded / evt.total) * 100));
      }
    };

    xhr.onload = () => {
      setUploading(false);
      setProgress(100);

      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          setBatchId(data.batch_id);
          setUploadTimestamp(data.upload_timestamp || null);
          setFilesResult(data.files || []);
          setDeals(data.deals_preview || []);
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
  }

  function downloadExcel() {
    if (!batchId) return;
    window.location.href = `${API_BASE}/export?batch_id=${batchId}`;
  }

  function renderChildren(children) {
    if (!Array.isArray(children) || children.length === 0) return null;
    return (
      <ul style={{ marginTop: 6 }}>
        {children.map((c, idx) => (
          <li key={idx}>
            <code>{c.source_file}</code> — <strong>{c.processing_status}</strong>
            {c.error ? <span style={{ color: "crimson" }}> — {c.error}</span> : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>CRM Deals Consolidation</h1>
      <p>
        Upload HubSpot CSV, Sales Excel, PDF reports, scanned contracts (images), or a ZIP containing any of these.
        Consolidated output follows the unified deal schema.
      </p>

      <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 10 }}>
        <label style={{ display: "block", marginBottom: 8 }}>
          <strong>Select files</strong> (Allowed: {acceptedHint})
        </label>

        <input type="file" multiple onChange={onChooseFiles} accept={acceptedHint} disabled={uploading} />

        {selectedFiles.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <strong>Selected:</strong>
            <ul>
              {selectedFiles.map((f) => (
                <li key={f.name}>
                  {f.name} ({Math.round(f.size / 1024)} KB)
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          onClick={upload}
          disabled={uploading || selectedFiles.length === 0}
          style={{ padding: "10px 14px", cursor: "pointer", marginTop: 8 }}
        >
          {uploading ? "Uploading..." : "Upload & Consolidate"}
        </button>

        {uploading && (
          <div style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 6 }}>Progress: {progress}%</div>
            <div style={{ height: 10, background: "#eee", borderRadius: 999, overflow: "hidden" }}>
              <div style={{ height: 10, width: `${progress}%`, background: "#333" }} />
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, color: "crimson" }}>
            <strong>Error:</strong> {error}
          </div>
        )}
      </div>

      {batchId && (
        <div style={{ marginTop: 22, padding: 16, border: "1px solid #ddd", borderRadius: 10 }}>
          <h2>Batch Result</h2>
          <div style={{ marginBottom: 10 }}>
            <div><strong>batch_id:</strong> <code>{batchId}</code></div>
            {uploadTimestamp ? <div><strong>upload_timestamp:</strong> <code>{uploadTimestamp}</code></div> : null}
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <button onClick={refreshAllRecords} style={{ padding: "8px 12px", cursor: "pointer" }}>
              Refresh consolidated rows
            </button>
            <button onClick={downloadExcel} style={{ padding: "8px 12px", cursor: "pointer" }}>
              Download Excel
            </button>
          </div>

          <h3>File processing status</h3>
          <ul>
            {filesResult.map((f, idx) => (
              <li key={idx} style={{ marginBottom: 8 }}>
                <code>{f.source_file}</code> — <strong>{f.processing_status}</strong>
                {f.error ? <span style={{ color: "crimson" }}> — {f.error}</span> : null}
                {f.children ? renderChildren(f.children) : null}
              </li>
            ))}
          </ul>

          <h3>Consolidated Deals (Unified Schema)</h3>
          {deals.length === 0 ? (
            <p>No deals found yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table cellPadding="8" style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    {SCHEMA_COLUMNS.map((h) => (
                      <th key={h} style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {deals.map((r, idx) => (
                    <tr key={idx}>
                      {SCHEMA_COLUMNS.map((k) => (
                        <td key={k} style={{ borderBottom: "1px solid #eee" }}>{r?.[k] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}