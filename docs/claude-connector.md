# Claude Code & Claude Desktop Integration

To connect TinyCloud Remote MCP server to Claude:

### Production Remote Server (`cloudery.xyz`):
```bash
# Add Production Remote MCP Server via SSE
claude mcp add --transport sse tinycloud https://mcp.cloudery.xyz/sse
```

Or add to your `claude_desktop_config.json`:
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
```bash
claude mcp add --transport http tinycloud http://localhost:4001/mcp
```
