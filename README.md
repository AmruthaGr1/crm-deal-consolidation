# CRM Deal Consolidation
Overview

This system consolidates multi-format CRM inputs into a unified schema using:

OCR for scanned documents

Groq LLM for structured data extraction

Supabase (Postgres) for storage

React dashboard for analytics and export

System Architecture
Processing Flow

<img width="716" height="796" alt="image" src="https://github.com/user-attachments/assets/b9552f8e-c0ec-480c-afa8-2d47cf5ab222" />



Step 1 – Upload

React frontend supports:

PDF

Excel (.xlsx / .xls)

CSV

JPG / PNG

ZIP (recursive extraction)



Step 2 – Text Extraction

Depending on file type:

File Type	Method
CSV	Deterministic parsing (pandas)
Excel	Deterministic parsing (pandas)
PDF	Embedded text extraction (PyMuPDF)
Image	OCR using Tesseract
ZIP	Extract → Process contained files

If PDF contains no embedded text → fallback to OCR.



Step 3 – LLM Structuring 

Raw extracted text is sent to Groq Cloud LLM.

The LLM is prompted to:

Extract structured fields

Normalize field names

Convert numeric formats

Return strictly valid JSON

The system prompt enforces:

Strict JSON output

Exact CRM schema keys

No hallucinated fields

Null for missing values

Numeric normalization (strip %, $, commas)

Reliability Handling

JSON mode enabled in Groq

Safe JSON parsing fallback



Step 4 – Database Storage

All structured deals are stored in Supabase Postgres.

Two tables:

uploads
Column	Purpose
id	Primary key
batch_id	Upload session grouping
source_file	File name
upload_timestamp	UTC timestamp
processing_status	uploaded / parsed / ai_extracted / failed
error	Error message if failed

deals
Column	Purpose
id	Primary key
batch_id	Links to upload
source_file	Original file
deal_id	Normalized deal identifier
client_name	Client
deal_value	Numeric pipeline value
stage	Deal stage
closing_probability	% probability
owner	Sales rep
expected_close_date	Forecast date


Step 5 – KPI Dashboard (Optional Requirement)

Built using Recharts.

Includes:

Total pipeline value

Closed Won and Total deals

Stage distribution (Bar chart)

Deals by owner

Expected close value by month



Step 6 – Export

Returns:

Consolidated Excel file

Unified schema

All structured deals

Unified Final Schema
deal_id
client_name
deal_value
stage
closing_probability
owner
expected_close_date

All sources are normalized into this schema.



Design Decisions

Batch-based architecture for upload isolation

UTC timestamps for consistency

LLM orchestration isolated in one function

OCR fallback logic for scanned PDFs

JSON-mode enforced to prevent malformed LLM output

Safe parsing to handle edge cases



Challenges Faced

LLM occasionally returning non-JSON — resolved using JSON mode + safe parsing.

OCR reliability — fallback strategy implemented.

Timezone inconsistencies — standardized to UTC.

Batch history UI readability — improved with formatted timestamps.



Cost Estimation (If Scaled)

At small scale:

Supabase Free

Groq free inference tier

Local OCR



Tech Stack

Frontend:

React (Vite)

Recharts (KPI charts)

Modern CSS

Backend:

FastAPI

Groq LLM API

PyMuPDF

Tesseract OCR

Pandas

Database:

Supabase (Postgres)


How to Run Locally
Backend
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload

Frontend
cd frontend
npm install
npm run dev


