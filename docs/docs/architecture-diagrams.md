# Architecture Diagrams

This document provides ready-to-edit Mermaid diagrams that explain the system from two viewpoints:

1. **Sequence diagram** - how a typical investigator request flows across modules.
2. **Module collaboration diagram** - how frontend, backend, and AI services connect.

You can paste these blocks into Mermaid Live Editor, GitHub Markdown, or export them locally with Mermaid CLI.

Scope reflected in the diagrams:
- Single user role: `Investigator`
- Case lifecycle: create case, upload files, manage/review case timeline, generate report
- CVR pipeline: denoise, transcribe, event detection, role identification, emotion recognition
- FDR pipeline: anomaly detection and parameter trend analysis

## 1) Sequence Diagram (Case Ingestion to Report)

```mermaid
sequenceDiagram
    autonumber
    actor Inv as Investigator
    participant FE as React Frontend
    participant API as Express API
    participant DB as PostgreSQL
    participant OBJ as MinIO/Object Storage
    participant CVR as Python CVR Inference Service
    participant FDR as Python FDR Anomaly Service

    Inv->>FE: Create case + upload CVR/FDR files
    FE->>API: POST /api/cases
    API->>DB: Insert case metadata
    DB-->>API: case_id
    API-->>FE: Case created

    FE->>API: POST /api/cases/{id}/attachments
    API->>OBJ: Store media payloads
    OBJ-->>API: object keys + urls
    API->>DB: Persist attachment references
    API-->>FE: Upload complete

    FE->>API: POST /api/cases/{id}/analyze
    API->>CVR: Submit CVR analysis job (denoise/transcribe/events/roles/emotions)
    API->>FDR: Submit FDR analysis job (flight-data anomalies/trends)
    CVR-->>API: denoised audio + transcript + events + roles + emotions
    FDR-->>API: anomaly segments + parameter trend summaries
    API->>DB: Save CVR/FDR analyses + correlated timeline
    API-->>FE: Analysis complete

    FE->>API: PATCH /api/cases/{id}
    API->>DB: Update case metadata/status
    API-->>FE: Case updated

    FE->>API: GET /api/cases/{id}/timeline
    API->>DB: Read correlated CVR/FDR timeline
    API-->>FE: Timeline + evidence entries
    FE-->>Inv: Review investigation timeline

    FE->>API: GET /api/cases/{id}/report
    API->>DB: Read full case bundle
    API-->>FE: Structured report payload
    FE-->>Inv: Render report for review/export
```

## 2) Module Collaboration Diagram

```mermaid
flowchart TB
    subgraph Frontend[React Application]
        Pages[Pages]
        Components[Shared Components]
        APIClient[API Client + Auth Token Handling]
        Pages --> Components
        Components --> APIClient
    end

    subgraph Backend[Node.js / Express]
        Routes[Routes]
        Middleware[Validation + Error Handling]
        CaseService[Case Service]
        StorageService[Storage Service]
        AnalysisService[Analysis Orchestrator]
        Routes --> Middleware --> CaseService
        CaseService --> StorageService
        CaseService --> AnalysisService
    end

    subgraph Data[Data Layer]
        Postgres[(PostgreSQL)]
        MinIO[(MinIO / S3 Bucket)]
    end

    subgraph AIServices[Python AI Services]
        Denoise[Audio Denoise]
        Whisper[Transcription]
        EventDetect[Event Detection]
        EmotionDetect[Emotion Recognition]
        RoleDetect[Role Identification]
        FDRDetect[FDR Anomaly Detection]
    end

    APIClient -->|HTTPS| Routes
    CaseService -->|SQL| Postgres
    StorageService -->|Object API| MinIO
    AnalysisService --> Denoise
    AnalysisService --> Whisper
    AnalysisService --> EventDetect
    AnalysisService --> EmotionDetect
    AnalysisService --> RoleDetect
    AnalysisService --> FDRDetect
    AnalysisService -->|Writes analysis outputs| Postgres
```

## Export as Images

```bash
# Best quality: vector output (no pixelation)
npx -y @mermaid-js/mermaid-cli -i docs/docs/architecture-diagrams.md -o docs/docs/architecture-diagrams.svg

# High-resolution PNG (4x scale)
npx -y @mermaid-js/mermaid-cli -i docs/docs/architecture-diagrams.md -o docs/docs/architecture-diagrams@4x.png -w 3200 -H 2200 -s 4
```

When exporting from a Markdown file with multiple Mermaid blocks, Mermaid CLI writes numbered outputs such as:
- `docs/docs/architecture-diagrams-1.svg`, `docs/docs/architecture-diagrams-2.svg`
- `docs/docs/architecture-diagrams@4x-1.png`, `docs/docs/architecture-diagrams@4x-2.png`
