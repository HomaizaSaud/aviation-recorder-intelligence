# CVR/FDR Analyzer

A single-page React application for aviation investigators to review cockpit voice recorder (CVR) and flight data recorder (FDR) cases. The dashboard surfaces high-level activity, provides quick entry points to case work, and links to focused tooling for timeline review, audio playback, correlation, and reporting.

## Features

- **Investigator dashboard** – Visualizes monthly incident/accident trends, maps case locations, and highlights recently accessed cases for quick follow-up.
- **Case workspace** – Navigate through pending investigations, drill into case details, and jump directly to CVR, FDR, correlation, and reporting tools.
- **Data correlation tools** – Dedicated views for pairing CVR transcripts with FDR parameters and producing shareable reports.
- **Responsive layout** – Built with Tailwind CSS and Lucide icons for a polished experience on desktop and tablet form factors.

## Prerequisites

Before installing the project dependencies ensure that you have the following software available locally:

- **Node.js** 18.0.0 or later (Node 20.x LTS recommended)
- **npm** 9.x or later (ships with Node.js)
- **PostgreSQL** 13 or later (for the case management API)

If you plan to exercise the MinIO-backed attachment workflow you will also need:

- **MinIO Server** (latest stable release) or another S3-compatible implementation
- **MinIO Client (mc)** for bucket administration (optional but recommended)

You can verify your toolchain with:

```bash
node --version
npm --version
```

## One-time setup

Install the project dependencies by running the helper script provided in this repository:

```bash
./install-requirements.sh
```

The script verifies that Node.js and npm are available before running `npm install` to pull in the dependencies listed in `package.json`.

> **Note**: If you prefer to install dependencies manually, you can run `npm install` in the project root.

## MinIO object storage setup

The backend integrates with an S3-compatible object store (MinIO by default) to host uploaded CVR/FDR files. Follow the steps below
to configure a local instance that mirrors the production workflow:

1. **Install MinIO**

   - **Docker (recommended for local testing):**

     ```bash
     docker run \
       -p 9000:9000 \
       -p 9001:9001 \
       -e MINIO_ROOT_USER=fdradmin \
       -e MINIO_ROOT_PASSWORD=supersecret123 \
       quay.io/minio/minio server /data --console-address :9001
     ```

   - **Native installation:** Download the latest release from [min.io](https://min.io/download#/linux) and follow the
     platform-specific instructions. Ensure the service listens on `http://127.0.0.1:9000` for development.

2. **Install the MinIO client (optional but helpful)**

   ```bash
   brew install minio/stable/mc    # macOS
   # or
   curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc
   ```

3. **Create a bucket for recorder data**

   ```bash
   mc alias set local http://127.0.0.1:9000 fdradmin supersecret123
   mc mb local/fdr-cvr-data
   ```

   The API will reuse the bucket if it already exists, so you only need to provision it once.

4. **Configure environment variables** – Update `server/.env` with your MinIO endpoint and credentials (see
   [`server/.env.example`](server/.env.example)). The key variables are:

   ```bash
   MINIO_ENDPOINT=http://127.0.0.1:9000
   MINIO_ACCESS_KEY=fdradmin
   MINIO_SECRET_KEY=supersecret123
   MINIO_REGION=us-east-1
   MINIO_BUCKET=fdr-cvr-data

   export MINIO_ROOT_USER=fdradmin
   export MINIO_ROOT_PASSWORD=supersecret123
   minio server $HOME/minio-data --address ":9000" --console-address ":9001"
   ```

   Optional overrides include `MINIO_USE_SSL`, `MINIO_PUBLIC_BASE_URL`, and the upload/download expiry timers.

5. **Verify connectivity** – Start the API with `npm run server`. The service performs a `HeadBucket` call and will create the
   bucket automatically if it is missing (useful when pointing at a fresh environment).

Once configured, the dashboard will upload FDR/CVR attachments directly to MinIO and persist the object keys in PostgreSQL.

## Running the application

1. **Provision the database**

   ```bash
   createdb cvr_fdr_analyzer
   ```

   The API automatically applies `server/db/schema.sql` on startup, so you only need to create the empty
   database once.

2. **Configure the API** – Copy `.env.example` and update the connection string if needed:

   ```bash
   cp server/.env.example server/.env
   ```

3. **Install backend dependencies** (run once per environment):

   ```bash
   npm install --prefix server
   ```

4. **Start the API server**:

   ```bash
   npm run server
   ```

   The REST API listens on [http://localhost:4000](http://localhost:4000) and exposes CRUD endpoints under `/api/cases`.

5. **Start the React app** in a second terminal:

   ```bash
   npm start
   ```

   The UI runs at [http://localhost:3000](http://localhost:3000) and proxies API requests to the backend.

## Building for production

Create an optimized production bundle in the `build/` directory:

```bash
npm run build
```

The output bundle is tree-shaken, minified, and ready to be deployed to your hosting platform of choice.

## Testing

Run the Create React App test runner in watch mode:

```bash
npm test
```

## Project structure

```
├── public/                # Static assets served as-is by CRA
├── server/                # Express + PostgreSQL REST API
│   ├── db/                # SQL schema and migration helpers
│   └── src/               # Server source (routes, services, middleware)
├── src/
│   ├── api/               # REST client helpers for the React app
│   ├── components/        # Shared React components (e.g., map visualizations)
│   ├── pages/             # Feature-specific screens (dashboard, CVR, FDR, etc.)
│   ├── App.js             # Main application shell and navigation
│   └── index.js           # React entry point
├── install-requirements.sh# Dependency installation helper script
├── package.json           # npm metadata and dependency list
├── docs/                  # Markdown documentation (e.g., architecture diagrams)
└── README.md              # Project documentation (this file)
```

## Viewing the documentation

Architecture notes and diagrams live in the `docs/` folder as Markdown files. You can view them directly in GitHub or any IDE
with Markdown preview support. For Mermaid diagrams, export a shareable image or PDF with the Mermaid CLI:

```bash
npx -y @mermaid-js/mermaid-cli -i docs/cvr-fdr-workflow-diagram.md -o docs/cvr-fdr-workflow.png
```

The command above writes a rendered diagram to `docs/cvr-fdr-workflow.png`. Feel free to change the output file extension (for
example, `.pdf`) to match the format you need.

## Available scripts

| Command | Description |
| ------- | ----------- |
| `npm start` | Runs the app in development mode with hot reload. |
| `npm test` | Launches the unit test runner in watch mode. |
| `npm run build` | Generates a production-optimized build. |
| `npm run eject` | Copies CRA configuration locally (irreversible). |
| `npm run server` | Starts the Express API on port 4000. |

## Troubleshooting

- **Port already in use**: The CRA dev server defaults to port 3000. Set `PORT=3001` (or another free port) before running `npm start` to use a different port.
- **Dependency issues**: Delete the `node_modules/` directory and rerun `./install-requirements.sh`.
- **Unsupported Node.js version**: Upgrade to the latest Active LTS release of Node.js.
- **"Unexpected server error" responses**: Run `npm run server` in a terminal to keep the API logs visible. The backend now prints the stack trace for unhandled errors and, when `NODE_ENV` is not set to `production`, also returns the specific error message in the JSON response (`details` field) so you can see the root cause directly in the browser network tab.

## License

This project is the intellectual property of the Aviation Center of Excellence (ACoE), developed in collaboration with the General Civil Aviation Authority (GCAA) and the University of Sharjah.

All rights are reserved. This repository is private and not open to the public.
Redistribution, reproduction, or use of the code—whether in whole or in part—is strictly prohibited without prior written permission from the project maintainers or the affiliated institutions.
