# TinyCloud GCP Deployment Process, Architecture & IAM Specification

> **Document Status**: Production Specification  
> **Target Environment**: GCP (Cloud Run, Cloud Build, Artifact Registry, GCS, Secret Manager)  
> **Primary Domain**: `cloudery.xyz` | **Region**: `us-central1` | **Project**: `agent-api-483208`

---

## Executive Summary & Root Cause Analysis

### Why Previous Implementations Used Mock Providers
In earlier prototypes, the GCP deployment module (`packages/deploy-gcp`) relied on mock response objects and hardcoded Cloud Run endpoints. This occurred because:
1. **Decoupled Development**: The control plane API and catalog routing were developed prior to establishing real GCP IAM Service Account credentials and Cloud Build triggers.
2. **Omission of Infrastructure Governance**: GCP permission models (IAM Service Accounts, storage bucket policies, build pack triggers) were not explicitly defined in the initial architecture documents, leading to superficial fallback stubs instead of real GCP API integrations.

This document replaces all assumptions, stubs, and mock workflows with an explicit, production-grade specification for end-to-end deployment, GCP IAM security, build execution, and access control.

---

## 1. End-to-End Deployment Workflow

The platform supports a **Universal Multi-Interface Entry Point**. Whether triggered via an AI Assistant (MCP), CLI, Git Webhook, or Web Dashboard, all requests map to a single endpoint in the Control Plane API (`api.cloudery.xyz`).

```
┌─────────────────────────────────────────────────────────────────┐
│                    INITIATION INTERFACES                        │
│  • MCP Tool (`publish_app`)       • CLI (`tinycloud deploy`)   │
│  • Git Push (Cloud Build/GitHub)  • Web UI (`app.cloudery.xyz`)│
└────────────────────────────────┬────────────────────────────────┘
                                 │
                                 ▼
                     [POST /api/apps/publish]
                     (Control Plane API Service)
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
1. Source Archival                              2. DB Metadata Record
   Stream code bundle to                           Register app slug, ACL,
   `gs://tinycloud-sources-{org_id}/`              and pending deployment status
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
   • Bind `tinycloud-agent-runtime-sa` Service Account
         │
         ▼
5. Routing & Access Control
   • Map `https://{app-slug}.cloudery.xyz` via Wildcard DNS
   • Edge Gateway (`tinycloud-gateway`) enforces Google Docs-level ACL
```

---

## 2. GCP IAM & Permissions Architecture

To ensure total isolation and prevent privilege escalation, tinycloud separates administrative control plane duties from container build execution and agent runtime execution using **3 dedicated GCP Service Accounts**.

```
 ┌───────────────────────────┐      ┌───────────────────────────┐      ┌───────────────────────────┐
 │   Control Plane SA        │      │   Cloud Build SA          │      │   Agent Runtime SA        │
 │ `tinycloud-control-plane` │      │ `tinycloud-cloudbuilder`  │      │ `tinycloud-agent-runtime` │
 └─────────────┬─────────────┘      └─────────────┬─────────────┘      └─────────────┬─────────────┘
               │                                  │                                  │
     Orchestrates GCP APIs              Reads Source & Pushes               Runs Deployed Agent
     (Cloud Run, GCS, Build)             Images to Registry                  Containers Safely
```

### 1. Control Plane Service Account (`tinycloud-control-plane-sa`)
* **Principal**: `tinycloud-control-plane-sa@agent-api-483208.iam.gserviceaccount.com`
* **Used by**: `tinycloud-api` backend service.
* **IAM Roles**:
  - `roles/cloudbuild.builds.editor`: Trigger, inspect, and cancel GCP Cloud Build jobs.
  - `roles/run.admin`: Full administrative control over Cloud Run services (`tc-*`).
  - `roles/storage.objectAdmin`: Read/write/delete source code zip archives in `gs://tinycloud-sources-*`.
  - `roles/iam.serviceAccountUser`: Permission to attach `tinycloud-agent-runtime-sa` to created Cloud Run services.
  - `roles/secretmanager.admin`: Store and inject encrypted environment secrets into Cloud Run configurations.

### 2. Cloud Build Service Account (`tinycloud-builder-sa`)
* **Principal**: `tinycloud-builder-sa@agent-api-483208.iam.gserviceaccount.com`
* **Used by**: GCP Cloud Build build engine.
* **IAM Roles**:
  - `roles/storage.objectViewer`: Read-only access to source code tarballs in `gs://tinycloud-sources-*`.
  - `roles/artifactregistry.writer`: Push built container images to `us-central1-docker.pkg.dev/agent-api-483208/agents/`.
  - `roles/logging.logWriter`: Write compilation and build logs to GCP Cloud Logging.

### 3. Agent Runtime Service Account (`tinycloud-agent-runtime-sa`)
* **Principal**: `tinycloud-agent-runtime-sa@agent-api-483208.iam.gserviceaccount.com`
* **Used by**: Deployed user agent containers (`tc-{app-slug}`).
* **IAM Roles (Strict Least-Privilege)**:
  - `roles/logging.logWriter`: Write application stdout/stderr logs to Cloud Logging.
  - `roles/monitoring.metricWriter`: Export container metric telemetries.
* **Security Boundary**: Deployed agents have **zero permissions** to query GCP management APIs, modify control plane databases, or inspect other tenant containers.

---

## 3. Cost & Latency Optimization (Cloud Run Configuration)

To satisfy **latency and cost priorities**, Cloud Run services are deployed with the following configuration flags:

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

* **Zero Idle Cost**: `minInstanceCount: 0` ensures $0 infrastructure spend when an agent is not handling traffic.
* **Cold Start Mitigation**: `startupCpuBoost: true` allocates 2 vCPUs during container launch to achieve sub-second cold start times.
* **Hot-Instance Upgrade**: Mission-critical agents can toggle `minInstanceCount: 1` via app settings when zero-latency is required.

---

## 4. Google Docs-Style Governance & Access Control

Every deployed app/agent maintains a strict **Access Control List (ACL)** in Neon PostgreSQL, enforced at the perimeter by `tinycloud-gateway`.

### RBAC Matrix
| Action | Owner | Editor | Viewer / User |
|---|:---:|:---:|:---:|
| Invoke / Execute Agent | ✅ | ✅ | ✅ |
| View App Details & Logs | ✅ | ✅ | ❌ |
| Update Code / Trigger Deploy | ✅ | ✅ | ❌ |
| Update Environment Secrets | ✅ | ✅ | ❌ |
| Change Share Policy / ACL | ✅ | ❌ | ❌ |
| Delete Agent Service | ✅ | ❌ | ❌ |

### Share Policy Modes
1. **Private**: Restrict execution to explicitly named user email addresses.
2. **Domain-Restricted**: Grant execution rights to all users belonging to specified email domains (e.g. `@acme.com`).
3. **Link / Public**: Grant execution rights to anyone possessing the share URL (or authenticated org members).

### Edge Gateway Enforcement Algorithm
When a request hits `https://{app-slug}.cloudery.xyz`:
1. `tinycloud-gateway` parses host header ➔ extracts `app-slug`.
2. Gateway queries Neon DB for the app's `SharePolicy` and `ACL`.
3. Gateway verifies the incoming user's session JWT.
4. **If Unauthorized**: Renders an interactive **403 Access Denied & Request Access** web interface.
5. **If Authorized**: Injects `X-TinyCloud-User-Id` and `X-TinyCloud-Org-Id` signed headers, then proxies the request to the origin Cloud Run URI (`tc-{app-slug}-us-central1.a.run.app`).

---

## 5. Implementation Roadmap (Replacing Mock Providers)

To transition from the current mock implementation in `packages/deploy-gcp` to live GCP infrastructure:

1. **GCP Project Setup**:
   - Enable GCP APIs: `run.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`, `storage.googleapis.com`.
   - Create Service Accounts (`tinycloud-control-plane-sa`, `tinycloud-builder-sa`, `tinycloud-agent-runtime-sa`).
   - Assign specified IAM roles to each service account.
2. **Storage & Registry Provisioning**:
   - Create private GCS bucket `gs://tinycloud-sources-agent-api-483208`.
   - Create private Artifact Registry repository `agents` in `us-central1`.
3. **Replace Mock Code in `packages/deploy-gcp/src/index.ts`**:
   - Replace dummy deployment IDs with GCP Cloud Build REST API (`POST https://cloudbuild.googleapis.com/v1/projects/{projectId}/builds`) and Cloud Run v2 REST API (`POST https://run.googleapis.com/v2/projects/{projectId}/locations/{region}/services`).
