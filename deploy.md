# TinyCloud Production Deployment — cloudery.xyz Custom Domain Layout

> **Full GCP Process & IAM Architecture Spec**: See [`docs/DEPLOYMENT_PROCESS_AND_GCP_ARCHITECTURE.md`](file:///C:/playground/tinycloud/docs/DEPLOYMENT_PROCESS_AND_GCP_ARCHITECTURE.md)

**Primary Domain**: `cloudery.xyz`  
**GCP Project ID**: `agent-api-483208`  
**GCP Region**: `us-central1`  
**Database**: Neon PostgreSQL (`ep-tiny-waterfall-az7ma645`)

---

## Production Domain & Subdomain Mapping Architecture

| Service | Target Subdomain | Cloud Run Service | Description |
|---|---|---|---|
| **Web Catalog Dashboard** | **`app.cloudery.xyz`** | `tinycloud-web` | Graphical UI for catalog, share policy editor & access approvals |
| **Control Plane API** | **`api.cloudery.xyz`** | `tinycloud-api` | Control Plane REST API for publishing, ACL, secrets & audit logs |
| **Remote MCP Server** | **`mcp.cloudery.xyz`** | `tinycloud-mcp` | Remote MCP Server endpoint (`https://mcp.cloudery.xyz/sse` & `/mcp`) |
| **Edge Auth Gateway** | **`*.cloudery.xyz`** | `tinycloud-gateway` | Wildcard domain for all published org apps (`https://{app-slug}.cloudery.xyz`) |

---

## How Wildcard App Routing Works (`*.cloudery.xyz`)

When an agent or developer publishes a custom app named `approval-tracker`:

1. **User opens**: `https://approval-tracker.cloudery.xyz`
2. **Wildcard DNS (`*.cloudery.xyz`)** routes the incoming request to **`tinycloud-gateway`**.
3. **`tinycloud-gateway`**:
   - Parses host `approval-tracker.cloudery.xyz` -> extracts slug `approval-tracker`.
   - Fetches the app's `SharePolicy` from Neon DB.
   - Enforces access (`org`, `private`, `link` allowlist).
   - If unauthorized ➔ Renders the interactive **403 Access Denied & Request Access** UI.
   - If authorized ➔ Injects signed identity header and proxies traffic to the app deployment origin.

---

## DNS Configuration Records in Cloudflare / Namecheap / Route 53

Add these CNAME records under your `cloudery.xyz` DNS settings:

| Type | Host / Subdomain | Target / Value | Purpose |
|---|---|---|---|
| **CNAME** | `app` | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `app.cloudery.xyz` to `tinycloud-web` |
| **CNAME** | `api` | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `api.cloudery.xyz` to `tinycloud-api` |
| **CNAME** | `mcp` | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `mcp.cloudery.xyz` to `tinycloud-mcp` |
| **CNAME** | `*` *(Wildcard)* | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `*.cloudery.xyz` to `tinycloud-gateway` |

---

## Connecting AI Assistants to `mcp.cloudery.xyz`

In Cursor `.cursor/mcp.json` or Claude Desktop:

```json
{
  "mcpServers": {
    "tinycloud": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.cloudery.xyz/sse"
      ],
      "env": {}
    }
  }
}
```
