# Cursor MCP Integration

Add TinyCloud Remote MCP server to `.cursor/mcp.json`:

### Production Remote Server (`cloudery.xyz`):
```json
{
  "mcpServers": {
    "tinycloud": {
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
    "tinycloud": {
      "url": "http://localhost:4001/mcp"
    }
  }
}
```
