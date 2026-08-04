# Cursor MCP Integration

Add Cloudery Remote MCP server to `.cursor/mcp.json`:

### Production Remote Server (`cloudery.xyz`):
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

### Local Development:
```json
{
  "mcpServers": {
    "cloudery": {
      "url": "http://localhost:4001/mcp"
    }
  }
}
```
