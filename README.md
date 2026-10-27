# Cloudery

> **Agent-First App Registry, Zero-Config Cloud Run Deployment & Access Governance Platform.**

Cloudery is an open-source platform that enables AI Assistants (Cursor, Claude Code, Codex, Custom Agents) and developers to build, deploy, manage, and secure internal micro-apps and tools in seconds with Google Docs-style access governance.

---

## Executive Architecture Summary (The Gist)

```
                     ┌──────────────────────────────────────┐
                     │          AI AGENTS & USERS           │
                     │ (Cursor, Claude, Web UI, CLI Tools)  │
                     └──────────────────┬───────────────────┘
                                        │
                                        ▼
                          https://*.cloudery.xyz
                                        │
                     ┌──────────────────┴───────────────────┐
                     │    Edge Auth Gateway Proxy           │
                     │    (cloudery-gateway)                │
                     │    Enforces Google Docs-Style ACL    │
                     └──────────────────┬───────────────────┘
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
   app.cloudery.xyz             api.cloudery.xyz           mcp.cloudery.xyz
 ┌───────────────────┐       ┌────────────────────┐     ┌────────────────────┐
 │  Web UI Catalog   │       │ Control Plane API  │     │ Remote MCP Server  │
 │  (cloudery-web)   │       │   (cloudery-api)   │     │   (cloudery-mcp)   │
 └───────────────────┘       └──────────┬─────────┘     └────────────────────┘
                                        │
                                        ▼
                             GCP Cloud Run Engine
                    (Automated Buildpacks & Isolation)
```

### Production Domain Layout (`cloudery.xyz`)

| Service | Domain Endpoint | Cloud Run Service | Description |
|---|---|---|---|
| **Web Catalog Dashboard** | [`app.cloudery.xyz`](https://app.cloudery.xyz) | `cloudery-web` | Graphical UI for catalog, share policy editor & access approvals |
| **Control Plane API** | [`api.cloudery.xyz`](https://api.cloudery.xyz) | `cloudery-api` | Control Plane REST API for publishing, ACL, secrets & audit logs |
| **Remote MCP Server** | [`mcp.cloudery.xyz`](https://mcp.cloudery.xyz) | `cloudery-mcp` | Remote MCP Server endpoint (`/sse` & `/mcp`) |
| **Edge Auth Gateway** | [`*.cloudery.xyz`](https://*.cloudery.xyz) | `cloudery-gateway` | Wildcard domain routing & ACL for published apps (`https://{app-slug}.cloudery.xyz`) |

---

## Monorepo Architecture

Cloudery is organized as a single self-hostable pnpm monorepo:

```
cloudery/
├── apps/
│   ├── api/          # Control Plane REST API & deployment orchestrator (@cloudery/api)
│   ├── gateway/      # Edge Auth Gateway proxy & multi-tenant ACL (@cloudery/gateway)
│   ├── mcp/          # Remote MCP Server endpoint (@cloudery/mcp)
│   └── web/          # React + Vite Catalog Dashboard UI (@cloudery/web)
├── packages/
│   ├── db/           # Drizzle ORM + PostgreSQL client repository (@cloudery/db)
│   ├── deploy-aws/   # AWS App Runner deployment provider (@cloudery/deploy-aws)
│   ├── deploy-gcp/   # GCP Cloud Run & Cloud Build provider (@cloudery/deploy-gcp)
│   ├── deploy-vercel/# Vercel deployment provider (@cloudery/deploy-vercel)
│   └── shared/       # Shared TypeScript interfaces & types (@cloudery/shared)
├── skills/
│   └── publish-internal-app/  # Antigravity skill for agent publishing
├── templates/        # Starter templates for Claude SDK, Google ADK, LangChain
├── docker-compose.yml
├── start.sh
└── turbo.json
```

---

## Quick Start (Local Development)

### Prerequisites
* Node.js 20+
* pnpm 9+
* Docker & Docker Compose

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/cloudery/cloudery.git
cd cloudery
pnpm install
```

### 2. Run with Docker Compose
```bash
docker compose up --build
```
Services will spin up on:
* **Control Plane API**: `http://localhost:4000`
* **Remote MCP Server**: `http://localhost:4001`
* **Edge Auth Gateway**: `http://localhost:4002`
* **Web Catalog UI**: `http://localhost:3000`

### 3. Run in Development Mode
```bash
pnpm dev
```

---

## Connecting AI Assistants to `mcp.cloudery.xyz`

### Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "cloudery": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.cloudery.xyz/sse"
      ]
    }
  }
}
```

### Claude Desktop / Claude Code
```bash
claude mcp add --transport sse cloudery https://mcp.cloudery.xyz/sse
```

### Codex CLI
```bash
codex mcp register cloudery --url http://localhost:4001/mcp
```

---

## Documentation Specs

* **Plans & Agent Evaluation Guide**: See [`plans.md`](file:///C:/playground/tinycloud/plans.md)
* **Deployment, Domain & GCP Architecture**: See [`docs/deployment.md`](file:///C:/playground/tinycloud/docs/deployment.md)
* **Claude Integration**: See [`docs/claude-connector.md`](file:///C:/playground/tinycloud/docs/claude-connector.md)
* **Cursor Integration**: See [`docs/cursor-mcp.md`](file:///C:/playground/tinycloud/docs/cursor-mcp.md)

---

## License

MIT License. Open-source and free for self-hosting and commercial use.

