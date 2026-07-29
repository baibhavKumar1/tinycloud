# TinyCloud Production Deployment — wishop.xyz Custom Domain Layout

**Primary Domain**: `wishop.xyz`  
**GCP Project ID**: `agent-api-483208`  
**GCP Region**: `us-central1`  
**Database**: Neon PostgreSQL (`ep-tiny-waterfall-az7ma645`)

---

## Production Domain & Subdomain Mapping Architecture

| Service | Target Subdomain | Cloud Run Service | Description |
|---|---|---|---|
| **Web Catalog Dashboard** | **`app.wishop.xyz`** | `tinycloud-web` | Graphical UI for catalog, share policy editor & access approvals |
| **Control Plane API** | **`api.wishop.xyz`** | `tinycloud-api` | Control Plane REST API for publishing, ACL, secrets & audit logs |
| **Remote MCP Server** | **`mcp.wishop.xyz`** | `tinycloud-mcp` | Remote MCP Server endpoint (`https://mcp.wishop.xyz/sse` & `/mcp`) |
| **Edge Auth Gateway** | **`*.wishop.xyz`** | `tinycloud-gateway` | Wildcard domain for all published org apps (`https://{app-slug}.wishop.xyz`) |

---

## How Wildcard App Routing Works (`*.wishop.xyz`)

When an agent or developer publishes a custom app named `approval-tracker`:

1. **User opens**: `https://approval-tracker.wishop.xyz`
2. **Wildcard DNS (`*.wishop.xyz`)** routes the incoming request to **`tinycloud-gateway`**.
3. **`tinycloud-gateway`**:
   - Parses host `approval-tracker.wishop.xyz` -> extracts slug `approval-tracker`.
   - Fetches the app's `SharePolicy` from Neon DB.
   - Enforces access (`org`, `private`, `link` allowlist).
   - If unauthorized ➔ Renders the interactive **403 Access Denied & Request Access** UI.
   - If authorized ➔ Injects signed identity header and proxies traffic to the app deployment origin.

---

## DNS Configuration Records in Cloudflare / Namecheap / Route 53

Add these CNAME records under your `wishop.xyz` DNS settings:

| Type | Host / Subdomain | Target / Value | Purpose |
|---|---|---|---|
| **CNAME** | `app` | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `app.wishop.xyz` to `tinycloud-web` |
| **CNAME** | `api` | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `api.wishop.xyz` to `tinycloud-api` |
| **CNAME** | `mcp` | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `mcp.wishop.xyz` to `tinycloud-mcp` |
| **CNAME** | `*` *(Wildcard)* | GCP Cloud Run CNAME (e.g. `ghs.googlehosted.com`) | Maps `*.wishop.xyz` to `tinycloud-gateway` |

---

## Connecting AI Assistants to `mcp.wishop.xyz`

In Cursor `.cursor/mcp.json` or Claude Desktop:

```json
{
  "mcpServers": {
    "tinycloud": {
      "$typeName": "exa.cascade_plugins_pb.CascadePluginCommandTemplate",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.wishop.xyz/sse"
      ],
      "env": {}
    }
  }
}
```
