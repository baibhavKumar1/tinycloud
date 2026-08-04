# Cloudery Plans & Agent Evaluation Specification

> **Document Status**: Active Product Roadmap & Benchmark Specification  
> **Scope**: Agent Evaluation Framework, Platform Features List, and Engineering Roadmap

---

## 1. Agent Evaluation Guide

Evaluating AI agents prior to and after deployment ensures safety, tool-execution correctness, performance SLA compliance, and cost efficiency.

### Evaluation Dimensions

| Dimension | Metric / Target | Description |
|---|---|---|
| **Tool Calling Accuracy** | `>= 98%` success rate | Evaluates if the agent selects valid tools, correct parameters, and properly handles tool errors. |
| **Share Policy & Access Control** | `100%` enforcement | Verifies that tenants and users cannot bypass domain or email restrictions enforced by [`apps/gateway`](file:///C:/playground/tinycloud/apps/gateway/src/index.ts). |
| **Response Latency (TTFT)** | `< 1.2s` initial token | Measures time-to-first-token and container cold-start delay on GCP Cloud Run. |
| **Execution Safety & Guardrails** | `0` unauthorized leaks | Ensures agents do not leak environment secrets, database credentials, or prompt injection payloads. |
| **Token & Cost Efficiency** | Optimized prompt length | Tracks input/output token usage per invocation to prevent runaway costs. |

---

### Step-by-Step Evaluation Workflow

#### 1. Pre-Deployment Tool Schema Validation
Before calling `publish_app`, validate `app.manifest.json` schema and tool parameters:
```json
{
  "$schema": "https://api.cloudery.xyz/schema/v1/manifest.json",
  "name": "approval-tracker-agent",
  "version": "1.0.0",
  "runtime": "python311",
  "entry": "main.py",
  "healthCheck": "/healthz"
}
```

#### 2. Local Container & Endpoint Health Check
Test container response against the health check endpoint:
```bash
curl -X GET http://localhost:8080/healthz
```
Expected output:
```json
{ "status": "ok", "agent": "approval-tracker-agent", "timestamp": "2026-08-04T13:06:00Z" }
```

#### 3. Edge Gateway Access Control Benchmark
Verify multi-tenant isolation and 403 enforcement:
```bash
# Test unauthorized domain access (Expect 403 Forbidden)
curl -H "X-User-Email: user@unauthorized.com" https://approval-tracker.cloudery.xyz/api/run

# Test authorized domain access (Expect 200 OK)
curl -H "X-User-Email: alex@acme.com" https://approval-tracker.cloudery.xyz/api/run
```

#### 4. Automated Benchmark Test Suite
Run end-to-end evaluation tests against deployed agent endpoints using synthetic prompt suites:
```bash
pnpm test:evals
```

---

## 2. Platform Features List

### Core Features (Available Now)

* **Agent-First Tool Publishing (`publish_app`)**:
  * One-step publishing for AI agents and micro-apps directly from Cursor, Claude Code, or Codex CLI via Remote MCP tools.

* **Google Docs-Style Access Governance**:
  * Fine-grained ACLs and Share Policies (`org`, `private`, `public_link`, domain allowlists) enforced at the network perimeter.

* **Remote MCP Server Endpoint (`mcp.cloudery.xyz`)**:
  * Native Model Context Protocol (MCP) server over SSE and HTTP JSON-RPC for seamless AI assistant integration.

* **Multi-Tenant Edge Auth Gateway (`cloudery-gateway`)**:
  * Reverse proxy routing wildcard domain traffic (`*.cloudery.xyz`) with identity injection (`X-Cloudery-Tenant`, `X-Cloudery-Identity`).

* **Zero-Config Cloud Run Deployment**:
  * Auto-packaging via buildpacks and Dockerfiles, $0 idle cost (`min-instances: 0`), and CPU startup boost.

* **Unified Web Catalog Dashboard (`app.cloudery.xyz`)**:
  * Graphical dashboard for managing published tools, reviewing audit logs, and approving access requests.

---

### Upcoming Feature Roadmap

#### Phase 1: Evaluation & Observability Suite
- [ ] **Automated Agent Eval Runner**: Built-in benchmark engine for testing agent tool execution accuracy before production release.
- [ ] **Real-Time Trace & Telemetry Viewer**: OpenTelemetry integration to visualize agent reasoning steps, tool calls, and LLM latency.
- [ ] **Tenant Token Cost Metering**: Granular dashboard tracking token usage and Cloud Run compute cost broken down by tenant and user.

#### Phase 2: Secret & Lifecycle Management
- [ ] **Automated Secret Rotation**: One-click sync with GCP Secret Manager for automatic API key rotation across agents.
- [ ] **Agent-to-Agent Event Bus**: Pub/sub messaging layer enabling agents to trigger and chain workflows asynchronously.
- [ ] **Custom Domain CNAME Wizard**: Automated SSL certificate generation for custom corporate domains (`agents.yourcompany.com`).
