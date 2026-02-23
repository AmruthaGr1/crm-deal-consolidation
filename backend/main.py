import os
import io
import json
import zipfile
import shutil
import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from PIL import Image
import pytesseract
import fitz  # PyMuPDF
import pandas as pd

from groq import Groq
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from dotenv import load_dotenv

# -----------------------------
# Config
# -----------------------------
load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set. Set it to your Postgres/Supabase connection string.")
if not GROQ_API_KEY:
    raise RuntimeError("GROQ_API_KEY is not set. Set it to your Groq API key.")

client = Groq(api_key=GROQ_API_KEY)

UPLOAD_DIR = "uploads"
TMP_DIR = "tmp"
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(TMP_DIR, exist_ok=True)

# Windows: ensure pytesseract finds tesseract.exe
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

ALLOWED_EXTENSIONS = {"pdf", "xlsx", "xls", "csv", "jpg", "jpeg", "png", "zip"}

# Unified CRM schema (from doc example)
CRM_KEYS = [
    "deal_id",
    "client_name",
    "deal_value",
    "stage",
    "closing_probability",
    "owner",
    "expected_close_date",
]

engine: Engine = create_engine(DATABASE_URL, pool_pre_ping=True)

# -----------------------------
# DB init
# -----------------------------
def init_db():
    with engine.begin() as conn:
        conn.execute(text("""
        CREATE TABLE IF NOT EXISTS uploads (
            id UUID PRIMARY KEY,
            batch_id UUID NOT NULL,
            source_file TEXT NOT NULL,
            upload_timestamp TIMESTAMP NOT NULL,
            processing_status TEXT NOT NULL,
            error TEXT NULL
        );
        """))
        conn.execute(text("""
        CREATE TABLE IF NOT EXISTS deals (
            id UUID PRIMARY KEY,
            batch_id UUID NOT NULL,
            source_file TEXT NOT NULL,
            deal_id TEXT NULL,
            client_name TEXT NULL,
            deal_value DOUBLE PRECISION NULL,
            stage TEXT NULL,
            closing_probability DOUBLE PRECISION NULL,
            owner TEXT NULL,
            expected_close_date TEXT NULL
        );
        """))

init_db()

# -----------------------------
# FastAPI app
# -----------------------------
app = FastAPI(title="CRM Deal Consolidation API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Helpers
# -----------------------------
def ext_of(name: str) -> str:
    parts = name.rsplit(".", 1)
    return parts[1].lower() if len(parts) == 2 else ""

def normalize_column_name(name: str) -> str:
    return name.strip().lower().replace(" ", "_")

def map_to_crm_schema(row: Dict[str, Any]) -> Dict[str, Any]:
    r = {normalize_column_name(str(k)): v for k, v in row.items()}

    def pick(*keys):
        for k in keys:
            if k in r and r[k] not in (None, ""):
                return r[k]
        return None

    deal_value = pick("amount", "deal_value", "value", "total", "deal_amount")
    closing_probability = pick(
        "close_probability_(%)", "close_probability", "probability", "closing_probability", "closing_probability_(%)"
    )

    # normalize probability to float 0-100
    if closing_probability is not None:
        try:
            closing_probability = float(str(closing_probability).replace("%", "").strip())
        except:
            closing_probability = None

    # normalize deal_value to float
    if deal_value is not None:
        try:
            deal_value = float(str(deal_value).replace(",", "").strip())
        except:
            deal_value = None

    out = {
        "deal_id": pick("deal_id", "id", "dealid", "deal"),
        "client_name": pick("company", "client_name", "client", "account", "customer"),
        "deal_value": deal_value,
        "stage": pick("stage", "deal_stage", "pipeline_stage"),
        "closing_probability": closing_probability,
        "owner": pick("owner", "deal_owner", "sales_rep", "salesperson"),
        "expected_close_date": pick("expected_close_date", "close_date", "expected_close", "forecast_close_date"),
    }
    # ensure all keys exist
    for k in CRM_KEYS:
        out.setdefault(k, None)
    return out

def ocr_image_path(image_path: str) -> str:
    img = Image.open(image_path)
    return pytesseract.image_to_string(img).strip()

def extract_pdf_text_or_ocr(pdf_path: str) -> str:
    doc = fitz.open(pdf_path)

    # 1) embedded text
    embedded = []
    for page in doc:
        t = page.get_text("text").strip()
        if t:
            embedded.append(t)
    embedded_text = "\n\n".join(embedded).strip()
    if len(embedded_text) >= 200:
        return embedded_text

    # 2) OCR pages (scanned)
    ocr_chunks = []
    for i in range(len(doc)):
        page = doc.load_page(i)
        pix = page.get_pixmap(dpi=200)
        tmp_img = os.path.join(TMP_DIR, f"{uuid.uuid4()}_p{i}.png")
        pix.save(tmp_img)
        try:
            ocr_chunks.append(ocr_image_path(tmp_img))
        finally:
            if os.path.exists(tmp_img):
                os.remove(tmp_img)
    return "\n\n".join([c for c in ocr_chunks if c]).strip()


def safe_json_loads(text_: str) -> dict:
    """
    Attempts to parse JSON even if model adds extra text.
    1) direct json.loads
    2) extract first {...} block and parse
    """
    if not text_ or not text_.strip():
        raise ValueError("Groq returned empty response (no JSON).")

    s = text_.strip()
    try:
        return json.loads(s)
    except Exception:
        pass

    # try to salvage: find first { and last }
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = s[start : end + 1]
        return json.loads(candidate)

    # give a helpful error for debugging
    raise ValueError(f"Groq returned non-JSON. First 200 chars: {s[:200]!r}")

def groq_extract_deals(raw_text: str, source_hint: str) -> List[Dict[str, Any]]:
    """
    Groq LLM: raw text -> strict JSON list of CRM deals.
    Required by doc: Groq Cloud LLMs, normalize field names, strict JSON. :contentReference[oaicite:14]{index=14}
    """
    schema_desc = {
        "deal_id": "string or null",
        "client_name": "string or null",
        "deal_value": "number or null",
        "stage": "string or null",
        "closing_probability": "number (0-100) or null",
        "owner": "string or null",
        "expected_close_date": "string (YYYY-MM-DD preferred) or null"
    }

    prompt = f"""
You are a data extraction engine for CRM deal documents.
Extract CRM deals from the provided text and return ONLY valid JSON.

Return a JSON object with this shape:
{{
  "deals": [ {{...}}, {{...}} ]
}}

Rules:
- Output MUST be strict JSON only. No explanations.
- Each deal object MUST contain EXACTLY these keys: {CRM_KEYS}
- If a field is missing, use null.
- closing_probability must be a number 0-100 (percent). If given as 0-1, convert to 0-100.
- deal_value must be numeric (remove commas/currency symbols).
- Normalize field names from messy sources.
- Do NOT invent deals not present.

Source type hint: {source_hint}

Schema:
{json.dumps(schema_desc, indent=2)}

TEXT:
\"\"\"{raw_text[:12000]}\"\"\"
"""
    # Use a fast, capable Groq model; you can change later if needed.
    resp = client.chat.completions.create(
    model="llama-3.3-70b-versatile",
    messages=[
        {"role": "system", "content": "You are a data extraction engine. Output ONLY a valid JSON object. No prose."},
        {"role": "user", "content": prompt},
    ],
    temperature=0,
    response_format={"type": "json_object"},
    )

    content = (resp.choices[0].message.content or "").strip()
    data = safe_json_loads(content)
    deals = data.get("deals", [])
    cleaned = []
    for d in deals:
        item = {k: d.get(k, None) for k in CRM_KEYS}
        # coerce numeric fields
        if item["deal_value"] is not None:
            try:
                item["deal_value"] = float(str(item["deal_value"]).replace(",", "").replace("$", "").strip())
            except:
                item["deal_value"] = None
        if item["closing_probability"] is not None:
            try:
                cp = float(str(item["closing_probability"]).replace("%", "").strip())
                # if it looks like 0-1, convert
                if 0 <= cp <= 1:
                    cp = cp * 100.0
                item["closing_probability"] = cp
            except:
                item["closing_probability"] = None
        cleaned.append(item)
    return cleaned

def save_upload_row(upload_id, batch_id, source_file, ts, status, error=None):
    with engine.begin() as conn:
        conn.execute(
            text("""
            INSERT INTO uploads (id, batch_id, source_file, upload_timestamp, processing_status, error)
            VALUES (:id, :batch_id, :source_file, :ts, :status, :error)
            """),
            {"id": str(upload_id), "batch_id": str(batch_id), "source_file": source_file, "ts": ts, "status": status, "error": error},
        )

def save_deals(batch_id, source_file, deals: List[Dict[str, Any]]):
    with engine.begin() as conn:
        for d in deals:
            conn.execute(
                text("""
                INSERT INTO deals (id, batch_id, source_file, deal_id, client_name, deal_value, stage,
                                   closing_probability, owner, expected_close_date)
                VALUES (:id, :batch_id, :source_file, :deal_id, :client_name, :deal_value, :stage,
                        :closing_probability, :owner, :expected_close_date)
                """),
                {
                    "id": str(uuid.uuid4()),
                    "batch_id": str(batch_id),
                    "source_file": source_file,
                    "deal_id": d.get("deal_id"),
                    "client_name": d.get("client_name"),
                    "deal_value": d.get("deal_value"),
                    "stage": d.get("stage"),
                    "closing_probability": d.get("closing_probability"),
                    "owner": d.get("owner"),
                    "expected_close_date": d.get("expected_close_date"),
                },
            )

def parse_csv(file_path: str) -> List[Dict[str, Any]]:
    df = pd.read_csv(file_path)
    df = df.where(pd.notnull(df), None)
    return [map_to_crm_schema(row) for row in df.to_dict(orient="records")]

def parse_excel(file_path: str) -> List[Dict[str, Any]]:
    df = pd.read_excel(file_path)
    df = df.where(pd.notnull(df), None)
    return [map_to_crm_schema(row) for row in df.to_dict(orient="records")]

def process_single_file(batch_id: uuid.UUID, file_path: str, original_name: str) -> Dict[str, Any]:
    """
    Orchestrator for ONE file (CSV / XLSX / PDF / Image).
    ZIP is handled separately and calls this for each extracted file.
    """
    ts = datetime.utcnow()
    upload_id = uuid.uuid4()
    ext = ext_of(original_name)

    save_upload_row(upload_id, batch_id, original_name, ts, "uploaded")

    try:
        if ext == "csv":
            deals = parse_csv(file_path)
            save_deals(batch_id, original_name, deals)
            # Update status
            with engine.begin() as conn:
                conn.execute(text("UPDATE uploads SET processing_status='parsed' WHERE id=:id"), {"id": str(upload_id)})
            return {"source_file": original_name, "processing_status": "parsed", "records_count": len(deals), "records_preview": deals[:3]}

        if ext in {"xlsx", "xls"}:
            deals = parse_excel(file_path)
            save_deals(batch_id, original_name, deals)
            with engine.begin() as conn:
                conn.execute(text("UPDATE uploads SET processing_status='parsed' WHERE id=:id"), {"id": str(upload_id)})
            return {"source_file": original_name, "processing_status": "parsed", "records_count": len(deals), "records_preview": deals[:3]}

        if ext in {"jpg", "jpeg", "png"}:
            raw_text = ocr_image_path(file_path)
            deals = groq_extract_deals(raw_text, source_hint="scanned_image_contract")
            save_deals(batch_id, original_name, deals)
            with engine.begin() as conn:
                conn.execute(text("UPDATE uploads SET processing_status='ai_extracted' WHERE id=:id"), {"id": str(upload_id)})
            return {"source_file": original_name, "processing_status": "ai_extracted", "records_count": len(deals), "text_preview": raw_text[:400], "records_preview": deals[:3]}

        if ext == "pdf":
            raw_text = extract_pdf_text_or_ocr(file_path)
            deals = groq_extract_deals(raw_text, source_hint="pdf_report_or_contract")
            save_deals(batch_id, original_name, deals)
            with engine.begin() as conn:
                conn.execute(text("UPDATE uploads SET processing_status='ai_extracted' WHERE id=:id"), {"id": str(upload_id)})
            return {"source_file": original_name, "processing_status": "ai_extracted", "records_count": len(deals), "text_preview": raw_text[:400], "records_preview": deals[:3]}

        # Unsupported
        with engine.begin() as conn:
            conn.execute(text("UPDATE uploads SET processing_status='rejected' WHERE id=:id"), {"id": str(upload_id)})
        return {"source_file": original_name, "processing_status": "rejected", "error": f"Unsupported file type: .{ext}"}

    except Exception as e:
        err = str(e)
        with engine.begin() as conn:
            conn.execute(text("UPDATE uploads SET processing_status='failed', error=:err WHERE id=:id"), {"id": str(upload_id), "err": err})
        return {"source_file": original_name, "processing_status": "failed", "error": err}

def process_zip(batch_id: uuid.UUID, zip_path: str, zip_name: str) -> List[Dict[str, Any]]:
    """
    Extract ZIP safely, process each allowed file inside.
    """
    results = []
    extract_dir = os.path.join(TMP_DIR, f"zip_{uuid.uuid4()}")
    os.makedirs(extract_dir, exist_ok=True)
    try:
        with zipfile.ZipFile(zip_path, "r") as z:
            for member in z.infolist():
                # basic safety: no absolute paths / traversal
                if member.filename.startswith("/") or ".." in member.filename.replace("\\", "/"):
                    continue
                z.extract(member, extract_dir)

        # walk extracted files
        for root, _, files in os.walk(extract_dir):
            for fn in files:
                ext = ext_of(fn)
                if ext not in ALLOWED_EXTENSIONS or ext == "zip":
                    continue
                full = os.path.join(root, fn)
                results.append(process_single_file(batch_id, full, fn))
        return results
    finally:
        shutil.rmtree(extract_dir, ignore_errors=True)

# -----------------------------
# API
# -----------------------------
@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/upload")

async def upload(files: List[UploadFile] = File(..., description="Upload one or more files")):    
    """
    Accept multiple files (including ZIP). Orchestrate processing for:
    - CSV: deterministic parse
    - Excel: deterministic parse
    - PDF: text extract or OCR -> Groq
    - Images: OCR -> Groq
    - ZIP: extract and process contained files
    """
    batch_id = uuid.uuid4()
    ts = datetime.utcnow()

    all_results = []
    for f in files:
        name = f.filename
        ext = ext_of(name)
        if ext not in ALLOWED_EXTENSIONS:
            all_results.append({"source_file": name, "processing_status": "rejected", "error": "Unsupported file type"})
            continue

        saved_path = os.path.join(UPLOAD_DIR, f"{batch_id}_{name}")
        content = await f.read()
        with open(saved_path, "wb") as out:
            out.write(content)

        if ext == "zip":
            # record upload row for zip itself
            zip_upload_id = uuid.uuid4()
            save_upload_row(zip_upload_id, batch_id, name, ts, "uploaded")
            zip_results = process_zip(batch_id, saved_path, name)
            with engine.begin() as conn:
                conn.execute(text("UPDATE uploads SET processing_status='expanded' WHERE id=:id"), {"id": str(zip_upload_id)})
            all_results.append({"source_file": name, "processing_status": "expanded", "children": zip_results})
        else:
            all_results.append(process_single_file(batch_id, saved_path, name))

    # consolidated preview from DB (first 10)
    with engine.begin() as conn:
        rows = conn.execute(
            text("""
            SELECT deal_id, client_name, deal_value, stage, closing_probability, owner, expected_close_date, source_file
            FROM deals WHERE batch_id=:batch_id
            LIMIT 10
            """),
            {"batch_id": str(batch_id)}
        ).mappings().all()

    return {
        "batch_id": str(batch_id),
        "message": "Processed files",
        "files": all_results,
        "deals_preview": list(rows),
        "upload_timestamp": ts.isoformat()
    }

@app.get("/records")
def records(batch_id: str):
    with engine.begin() as conn:
        rows = conn.execute(
            text("""
            SELECT deal_id, client_name, deal_value, stage, closing_probability, owner, expected_close_date, source_file
            FROM deals
            WHERE batch_id=:batch_id
            ORDER BY source_file
            """),
            {"batch_id": batch_id}
        ).mappings().all()
    return {"batch_id": batch_id, "records": list(rows), "count": len(rows)}

@app.get("/kpis")
def kpis(batch_id: str):
    """
    Optional KPI dashboard for a batch_id.
    Computes summary metrics from the deals table.
    """
    with engine.begin() as conn:
        rows = conn.execute(
            text("""
            SELECT deal_id, client_name, deal_value, stage, closing_probability, owner, expected_close_date, source_file
            FROM deals
            WHERE batch_id=:batch_id
            """),
            {"batch_id": batch_id}
        ).mappings().all()

    data = list(rows)
    if not data:
        return {
            "batch_id": batch_id,
            "total_deals": 0,
            "total_value": 0,
            "avg_probability": None,
            "value_by_stage": [],
            "deals_by_owner": [],
            "value_by_month": [],
        }

    # helpers
    def safe_float(x):
        try:
            if x is None or x == "":
                return None
            return float(x)
        except:
            return None

    total_deals = len(data)
    values = [safe_float(r.get("deal_value")) for r in data]
    probs = [safe_float(r.get("closing_probability")) for r in data]

    total_value = sum([v for v in values if v is not None])

    prob_valid = [p for p in probs if p is not None]
    avg_probability = (sum(prob_valid) / len(prob_valid)) if prob_valid else None

    # value by stage
    stage_map = {}
    for r in data:
        stage = r.get("stage") or "Unknown"
        v = safe_float(r.get("deal_value")) or 0.0
        stage_map[stage] = stage_map.get(stage, 0.0) + v
    value_by_stage = [{"stage": k, "value": round(v, 2)} for k, v in stage_map.items()]
    value_by_stage.sort(key=lambda x: x["value"], reverse=True)

    # deals by owner
    owner_map = {}
    for r in data:
        owner = r.get("owner") or "Unknown"
        owner_map[owner] = owner_map.get(owner, 0) + 1
    deals_by_owner = [{"owner": k, "count": v} for k, v in owner_map.items()]
    deals_by_owner.sort(key=lambda x: x["count"], reverse=True)

    # value by expected close month (YYYY-MM)
    month_map = {}
    for r in data:
        d = (r.get("expected_close_date") or "").strip()
        # supports YYYY-MM-DD or YYYY-MM
        month = None
        if len(d) >= 7 and d[4] == "-":
            month = d[:7]
        if not month:
            month = "Unknown"
        v = safe_float(r.get("deal_value")) or 0.0
        month_map[month] = month_map.get(month, 0.0) + v
    value_by_month = [{"month": k, "value": round(v, 2)} for k, v in month_map.items()]
    # put Unknown last
    value_by_month.sort(key=lambda x: (x["month"] == "Unknown", x["month"]))

    return {
        "batch_id": batch_id,
        "total_deals": total_deals,
        "total_value": round(total_value, 2),
        "avg_probability": round(avg_probability, 2) if avg_probability is not None else None,
        "value_by_stage": value_by_stage,
        "deals_by_owner": deals_by_owner,
        "value_by_month": value_by_month,
    }

@app.get("/batches")
def batches(limit: int = 20):
    """
    Returns recent batch_ids from uploads table, newest first.
    Includes upload_timestamp and file count.
    """
    with engine.begin() as conn:
        rows = conn.execute(
            text("""
            SELECT
              batch_id,
              MAX(upload_timestamp) AS latest_upload,
              COUNT(*) AS files_count
            FROM uploads
            GROUP BY batch_id
            ORDER BY latest_upload DESC
            LIMIT :limit
            """),
            {"limit": limit}
        ).mappings().all()

    return {"batches": [dict(r) for r in rows], "count": len(rows)}

@app.get("/export")
def export(batch_id: str):
    with engine.begin() as conn:
        rows = conn.execute(
            text("""
            SELECT deal_id, client_name, deal_value, stage, closing_probability, owner, expected_close_date, source_file
            FROM deals
            WHERE batch_id=:batch_id
            ORDER BY source_file
            """),
            {"batch_id": batch_id}
        ).mappings().all()

    df = pd.DataFrame(list(rows))
    if df.empty:
        raise HTTPException(status_code=404, detail="No records found for this batch_id")

    out = io.BytesIO()
    df.to_excel(out, index=False, sheet_name="ConsolidatedDeals")
    out.seek(0)

    filename = f"crm_deals_{batch_id}.xlsx"
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return StreamingResponse(out, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers=headers)