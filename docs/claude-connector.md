# Claude Code & Claude Desktop Integration

To connect TinyCloud Remote MCP server to Claude:

```bash
# Add TinyCloud MCP Server
claude mcp add --transport http tinycloud http://localhost:4001/mcp
```

Or add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tinycloud": {
      "url": "http://localhost:4001/mcp"
    }
  }
}
```
