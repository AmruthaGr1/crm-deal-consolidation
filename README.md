CRM Deal Consolidation
Overview

This system consolidates multi-format CRM inputs into a unified schema using OCR for scanned documents, Groq LLM for structured data extraction, Supabase (Postgres) for storage, and a React dashboard for analytics and export.

System Architecture

Processing Flow

<img width="716" height="796" alt="image" src="https://github.com/user-attachments/assets/b9552f8e-c0ec-480c-afa8-2d47cf5ab222" />



Step 1 – Upload (Frontend)

The React dashboard supports the following file formats:

PDF

Excel

CSV

JPG and PNG

ZIP (recursive extraction of supported files)

Step 2 – Text Extraction

Depending on file type: File Type Method CSV Deterministic parsing (pandas) Excel Deterministic parsing (pandas) PDF Embedded text extraction (PyMuPDF) Image OCR using Tesseract ZIP Extract → Process contained files If PDF contains no embedded text → fallback to OCR.

Step 3 – LLM Structuring

Raw extracted text is sent to the Groq Cloud LLM to:

Extract structured CRM fields

Normalize field names

Convert numeric formats

Return strictly valid JSON



Step 4 – Database Storage

All structured deals are stored in Supabase Postgres.

Database tables:

uploads

deals

A batch-based architecture ensures upload isolation and traceability.

Step 5 – KPI Dashboard

Built using Recharts.

Includes:

Total pipeline value

Closed Won and Total deals

Stage distribution (bar chart)

Deals by owner

Expected close value by month

Step 6 – Export

The system generates:

Consolidated Excel file

Unified schema output

All structured deals

Unified Final Schema

All sources are normalized into the following schema:

deal_id
client_name
deal_value
stage
closing_probability
owner
expected_close_date

Design Decisions

Batch-based architecture for upload isolation

UTC timestamps for consistency

LLM orchestration isolated in a dedicated function

OCR fallback logic for scanned PDFs

Safe parsing to handle edge cases

Challenges Faced

OCR reliability issues, handled with fallback strategy

Timezone inconsistencies, standardized to UTC

Batch history UI readability, improved with formatted timestamps

Cost Estimation

Supabase Free Tier

Groq free inference tier

Local OCR processing

Tech Stack

Frontend
React (Vite)
Recharts
Modern CSS

Backend
FastAPI
Groq LLM API
PyMuPDF
Tesseract OCR
Pandas

Database
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




