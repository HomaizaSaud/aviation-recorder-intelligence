# Docker Setup — Aviation Recorder Intelligence

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│   Backend   │────▶│  PostgreSQL │
│  React:3000 │     │ Express:4000│     │    :5432    │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────┴──────┐     ┌─────────────┐
                    │   Python    │     │    MinIO    │
                    │  Model:5000 │     │  :9000/9001 │
                    └─────────────┘     └─────────────┘
```

## First-time setup

### 1. Make sure Docker Desktop is running

Download from https://www.docker.com/products/docker-desktop if needed.

### 2. Create your .env file

```bash
cp .env.example .env
```

The defaults in `.env.example` work out of the box for local development.

### 3. Build and start all services

```bash
docker compose up --build
```

First build takes ~3-5 minutes (downloading base images + installing deps).
Subsequent starts are fast since layers are cached.

### 4. Open the app

| Service         | URL                        |
|-----------------|----------------------------|
| Frontend (app)  | http://localhost:3000      |
| Backend API     | http://localhost:4000      |
| MinIO console   | http://localhost:9001      |
| PostgreSQL      | localhost:5432             |

MinIO console login: `minioadmin` / `minioadmin`

---

## Daily development workflow

### Start everything
```bash
docker compose up
```

### Start with hot reload (recommended for active development)
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```
This mounts your local source folders into the containers — changes to
`src/`, `server/src/`, and `python_model/` reload automatically.

### Stop everything
```bash
docker compose down
```

### Stop and wipe the database (fresh start)
```bash
docker compose down -v
```

### Rebuild a single service after dependency changes
```bash
docker compose build backend
docker compose up backend
```

### View logs for a specific service
```bash
docker compose logs -f backend
docker compose logs -f python_model
```

### Open a shell inside a container (for debugging)
```bash
docker compose exec backend sh
docker compose exec db psql -U postgres -d cvr_fdr_analyzer
```

---

## Sharing with a colleague

Your colleague just needs:
1. Docker Desktop installed
2. A clone of this repo
3. Run `cp .env.example .env && docker compose up --build`

No Node, Python, PostgreSQL, or MinIO installation needed on their machine.

---

## Troubleshooting

**Port already in use**
```bash
# Find what's using the port (e.g. 5432)
netstat -ano | findstr :5432     # Windows
lsof -i :5432                    # Mac/Linux
```
Then either stop the conflicting process or change the port mapping in
`docker-compose.yml` (e.g. `"5433:5432"`).

**Frontend can't reach backend**
Make sure `REACT_APP_API_URL` in `.env` matches the backend port. In
production mode the nginx proxy handles this automatically.

**Python model fails to start**
Check that `python_model/requirements.txt` exists. If the model has no
`app.py` yet, the container will exit — that's fine, the rest of the
stack still works.

**Database schema not applied**
The backend applies `server/db/schema.sql` on startup automatically.
If you need to re-apply: `docker compose exec db psql -U postgres -d cvr_fdr_analyzer -f /dev/stdin < server/db/schema.sql`
