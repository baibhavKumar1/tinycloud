# Cloudery Production Deployment, Domain Setup & GCP Architecture

> **Document Status**: Complete Production & Infrastructure Specification  
> **Target Environment**: GCP (Cloud Run, Cloud Build, Artifact Registry, GCS, Secret Manager)  
> **Primary Domain**: `cloudery.xyz` | **Region**: `us-central1` | **GCP Project**: `agent-api-483208` | **Database**: Neon PostgreSQL

---

## 1. Domain & Subdomain Architecture

### Production Service Endpoint Mapping

| Service | Target Subdomain | Cloud Run Service | Description |
|---|---|---|---|
| **Web Catalog Dashboard** | **`app.cloudery.xyz`** | `cloudery-web` | Graphical UI for catalog, share policy editor & access approvals |
| **Control Plane API** | **`api.cloudery.xyz`** | `cloudery-api` | Control Plane REST API for publishing, ACL, secrets & audit logs |
| **Remote MCP Server** | **`mcp.cloudery.xyz`** | `cloudery-mcp` | Remote MCP Server endpoint (`https://mcp.cloudery.xyz/sse` & `/mcp`) |
| **Edge Auth Gateway** | **`*.cloudery.xyz`** | `cloudery-gateway` | Wildcard domain for all published org apps (`https://{app-slug}.cloudery.xyz`) |

---

## 2. DNS Configuration Records

Add these CNAME records under your `cloudery.xyz` DNS provider settings (Cloudflare, Route 53, Namecheap, etc.):

| Type | Host / Subdomain | Target / Value | Purpose |
|---|---|---|---|
| **CNAME** | `app` | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `app.cloudery.xyz` to `cloudery-web` |
| **CNAME** | `api` | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `api.cloudery.xyz` to `cloudery-api` |
| **CNAME** | `mcp` | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `mcp.cloudery.xyz` to `cloudery-mcp` |
| **CNAME** | `*` *(Wildcard)* | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `*.cloudery.xyz` to `cloudery-gateway` |

---

## 3. How Wildcard App Routing Works (`*.cloudery.xyz`)

When an agent or developer publishes a custom app named `approval-tracker`:

1. **User opens**: `https://approval-tracker.cloudery.xyz`
2. **Wildcard DNS (`*.cloudery.xyz`)** routes the incoming request to **`cloudery-gateway`**.
3. **`cloudery-gateway`**:
   - Parses host `approval-tracker.cloudery.xyz` -> extracts slug `approval-tracker`.
   - Fetches the app's `SharePolicy` from Neon DB.
   - Enforces access (`org`, `private`, `link` allowlist).
   - If unauthorized -> Renders the interactive **403 Access Denied & Request Access** UI.
   - If authorized -> Injects signed identity header (`X-Cloudery-Tenant`, `X-Cloudery-Identity`) and proxies traffic to origin deployment.

---

## 4. End-to-End Build & Deployment Workflow

The platform supports a **Universal Multi-Interface Entry Point**. Whether triggered via an AI Assistant (MCP), CLI, Git Webhook, or Web Dashboard, all requests map to a single endpoint in the Control Plane API (`api.cloudery.xyz`).

```
┌─────────────────────────────────────────────────────────────────┐
│                    INITIATION INTERFACES                        │
│  • MCP Tool (`publish_app`)       • CLI (`cloudery deploy`)    │
│  • Git Push (Cloud Build/GitHub)  • Web UI (`app.cloudery.xyz`)│
└────────────────┬────────────────────────────────┘
                                 │
                                 ▼
                     [POST /api/apps/publish]
                     (Control Plane API Service)
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
1. Source Archival                              2. DB Metadata Record
   Stream code bundle to                           Register app slug, ACL,
   `gs://cloudery-sources-{org_id}/`               and pending deployment status
         │
         ▼
3. Cloud Build Pipeline (GCP)
   • Check for custom `Dockerfile`
   • Fallback: Google Cloud Buildpacks (zero-config source-to-container)
   • Output image to private Artifact Registry:
     `us-central1-docker.pkg.dev/agent-api-483208/agents/{app-slug}:{version}`
         │
         ▼
4. Cloud Run Provisioning
   • Deploy service `tc-{app-slug}` to Cloud Run
   • Apply runtime flags: `min-instances: 0` (cost=$0 idle), CPU Startup Boost
   • Bind `cloudery-agent-runtime-sa` Service Account
         │
         ▼
5. Routing & Access Control
   • Map `https://{app-slug}.cloudery.xyz` via Wildcard DNS
   • Edge Gateway (`cloudery-gateway`) enforces Google Docs-level ACL
```

---

## 5. GCP IAM & Permissions Architecture

To ensure total isolation and prevent privilege escalation, Cloudery separates administrative control plane duties from container build execution and agent runtime execution using **3 dedicated GCP Service Accounts**.

```
 ┌───────────────────────────┐      ┌───────────────────────────┐      ┌───────────────────────────┐
 │   Control Plane SA        │      │   Cloud Build SA          │      │   Agent Runtime SA        │
 │ `cloudery-control-plane`  │      │ `cloudery-cloudbuilder`   │      │ `cloudery-agent-runtime`  │
 └─────────────┬─────────────┘      └─────────────┬─────────────┘      └─────────────┬─────────────┘
               │                                  │                                  │
     Orchestrates GCP APIs              Reads Source & Pushes               Runs Deployed Agent
     (Cloud Run, GCS, Build)             Images to Registry                  Containers Safely
```

### 1. Control Plane Service Account (`cloudery-control-plane-sa`)
* **Principal**: `cloudery-control-plane-sa@agent-api-483208.iam.gserviceaccount.com`
* **Used by**: `cloudery-api` backend service.
* **IAM Roles**:
  - `roles/cloudbuild.builds.editor`: Trigger, inspect, and cancel GCP Cloud Build jobs.
  - `roles/run.admin`: Full administrative control over Cloud Run services (`tc-*`).
  - `roles/storage.objectAdmin`: Read/write/delete source code archives in `gs://cloudery-sources-*`.
  - `roles/iam.serviceAccountUser`: Permission to attach `cloudery-agent-runtime-sa` to created Cloud Run services.
  - `roles/secretmanager.admin`: Store and inject encrypted environment secrets into Cloud Run configurations.

### 2. Cloud Build Service Account (`cloudery-builder-sa`)
* **Principal**: `cloudery-builder-sa@agent-api-483208.iam.gserviceaccount.com`
* **Used by**: GCP Cloud Build engine.
* **IAM Roles**:
  - `roles/storage.objectViewer`: Read-only access to source code tarballs in `gs://cloudery-sources-*`.
  - `roles/artifactregistry.writer`: Push built container images to Artifact Registry (`agents`).
  - `roles/logging.logWriter`: Write compilation and build logs to GCP Cloud Logging.

### 3. Agent Runtime Service Account (`cloudery-agent-runtime-sa`)
* **Principal**: `cloudery-agent-runtime-sa@agent-api-483208.iam.gserviceaccount.com`
* **Used by**: Deployed user agent containers (`tc-{app-slug}`).
* **IAM Roles (Strict Least-Privilege)**:
  - `roles/logging.logWriter`: Write application stdout/stderr logs to Cloud Logging.
  - `roles/monitoring.metricWriter`: Export container metric telemetries.
* **Security Boundary**: Deployed agents have zero permissions to query GCP management APIs or inspect other tenant containers.

---

## 6. Cost & Latency Optimization (Cloud Run Config)

Cloud Run services are deployed with the following configuration:

```json
{
  "serviceName": "tc-{app-slug}",
  "template": {
    "containers": [
      {
        "image": "us-central1-docker.pkg.dev/agent-api-483208/agents/{app-slug}:{version}",
        "resources": {
          "limits": {
            "cpu": "1000m",
            "memory": "512Mi"
          }
        },
        "startupProbe": {
          "httpGet": { "path": "/healthz", "port": 8080 },
          "periodSeconds": 3,
          "failureThreshold": 5
        }
      }
    ],
    "scaling": {
      "minInstanceCount": 0,
      "maxInstanceCount": 10
    },
    "cpuIdle": true,
    "startupCpuBoost": true
  }
}
```

* **Zero Idle Cost**: `minInstanceCount: 0` ensures $0 spend when an agent is not handling traffic.
* **Cold Start Mitigation**: `startupCpuBoost: true` allocates 2 vCPUs during container launch to achieve sub-second cold start times.

---

## 7. Access Governance (Google Docs-Style ACL)

Every deployed app maintains an Access Control List (ACL) in Neon PostgreSQL, enforced at the perimeter by `cloudery-gateway`.

### RBAC Matrix
| Action | Owner | Editor | Viewer / User |
|---|:---:|:---:|:---:|
| Invoke / Execute Agent | ✅ | ✅ | ✅ |
| View App Details & Logs | ✅ | ✅ | ❌ |
| Update Code / Trigger Deploy | ✅ | ✅ | ❌ |
| Update Environment Secrets | ✅ | ✅ | ❌ |
| Change Share Policy / ACL | ✅ | ❌ | ❌ |
| Delete Agent Service | ✅ | ❌ | ❌ |

---

## 8. Connecting AI Assistants to `mcp.cloudery.xyz`

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
