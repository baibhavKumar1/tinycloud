#!/bin/sh

case "$SERVICE_NAME" in
  api)
    echo "[TinyCloud] Starting Control Plane API service on port ${PORT:-4000}..."
    exec node apps/api/dist/server.js
    ;;
  mcp)
    echo "[TinyCloud] Starting Remote MCP Server service on port ${PORT:-4001}..."
    exec node apps/mcp/dist/index.js
    ;;
  gateway)
    echo "[TinyCloud] Starting Edge Auth Gateway proxy service on port ${PORT:-4002}..."
    exec node apps/gateway/dist/index.js
    ;;
  web)
    echo "[TinyCloud] Starting Web Catalog Dashboard UI on port ${PORT:-3000}..."
    exec node apps/web/server.js
    ;;
  *)
    echo "[TinyCloud] Starting all services in development mode..."
    exec pnpm dev
    ;;
esac
