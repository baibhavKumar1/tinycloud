import express, { Request, Response } from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const PORT = process.env.PORT || 4001;
const API_URL = process.env.API_URL || process.env.CONTROL_PLANE_URL || (process.env.K_SERVICE ? 'https://cloudery-api-1054958029786.us-central1.run.app' : 'http://localhost:4000');

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize Official Model Context Protocol (MCP) Server instance
const mcpServer = new Server(
  {
    name: 'cloudery-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// MCP Tool Definitions
const TOOLS = [
  {
    name: 'publish_app',
    description: 'Publish and deploy an agent or internal app for your organization in 1 single call. Registers the app, builds container artifact, automatically encrypts and mounts secrets in GCP Secret Manager, and applies security share policy.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the internal tool or agent (e.g. "sales-bot")' },
        slug: { type: 'string', description: 'URL slug for the app' },
        runtime: { type: 'string', description: 'Runtime environment specification. MUST follow strict format "python311", "python314", "node20", "node23", "node24" (NO DOTS!).' },
        files: { type: 'object', description: 'Dictionary of filename to file content (e.g. {"main.py": "...", "requirements.txt": "..."}). Include "app.manifest.json" ($schema, name, runtime: "python311", entry: "main.py", filesCount: 6, port: 8080).' },
        secrets: { type: 'object', description: 'Optional dictionary of environment secret keys to encrypted values (e.g. {"OPENROUTER_API_KEY": "sk-or-v1-..."}). Secrets are automatically encrypted in GCP Secret Manager and mounted to Cloud Run.' },
        provider: { type: 'string', enum: ['vercel', 'gcp', 'aws'], description: 'Target cloud deploy provider' },
        visibility: { type: 'string', enum: ['private', 'org', 'link'], description: 'Default access visibility' },
        allowedDomains: { type: 'array', items: { type: 'string' }, description: 'Allowed email domains (e.g. ["acme.com"])' },
        allowedEmails: { type: 'array', items: { type: 'string' }, description: 'Allowed specific email addresses' },
      },
      required: ['name'],
    },
  },
  {
    name: 'share_app',
    description: 'Configure doc-like sharing policy for an existing internal app (restrict to domain, allow specific emails, or toggle visibility).',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'The unique appId' },
        visibility: { type: 'string', enum: ['private', 'org', 'link'] },
        allowedDomains: { type: 'array', items: { type: 'string' } },
        allowedEmails: { type: 'array', items: { type: 'string' } },
      },
      required: ['appId'],
    },
  },
  {
    name: 'list_org_apps',
    description: 'List all internal applications in the organization catalog with status, share URLs, and owners.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_app',
    description: 'Get detailed information, current share URL, share policy, and deployment status for an app.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'The unique appId' },
      },
      required: ['appId'],
    },
  },
  {
    name: 'get_audit_log',
    description: 'Fetch the security and governance audit trail for an internal app (who deployed what agent output, access events, share policy changes).',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'The unique appId' },
      },
      required: ['appId'],
    },
  },
  {
    name: 'rollback_app',
    description: 'Rollback an internal application to a previous deployment version.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'The unique appId' },
        targetDeploymentId: { type: 'string', description: 'Target deployment ID to restore' },
      },
      required: ['appId'],
    },
  },
  {
    name: 'set_app_secret',
    description: 'Store or update an encrypted environment secret variable for an app (scoped to production, staging, or development). Auto-mounts to GCP Secret Manager.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'The unique appId' },
        key: { type: 'string', description: 'Environment variable key name (e.g. OPENROUTER_API_KEY)' },
        value: { type: 'string', description: 'Secret variable value' },
        environment: { type: 'string', enum: ['production', 'staging', 'development'], description: 'Target deployment environment' },
      },
      required: ['appId', 'key', 'value'],
    },
  },
  {
    name: 'list_app_secrets',
    description: 'List configured environment secret variable keys for an app (masked values).',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'The unique appId' },
      },
      required: ['appId'],
    },
  },
  {
    name: 'create_from_template',
    description: 'Instantiate a new internal tool or agent server from a golden path primitive (approval-system, team-dashboard, agent-langchain, agent-google-adk, agent-claude-sdk).',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', enum: ['approval-system', 'team-dashboard', 'agent-langchain', 'agent-google-adk', 'agent-claude-sdk'] },
        name: { type: 'string' },
        provider: { type: 'string', enum: ['vercel', 'gcp', 'aws'] },
        allowedDomains: { type: 'array', items: { type: 'string' } },
      },
      required: ['templateId', 'name'],
    },
  },
];

// Tool Execution Handler
async function handleToolCall(name: string, args: any) {
  switch (name) {
    case 'publish_app': {
      const res = await fetch(`${API_URL}/api/apps/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...args,
          actorId: 'agent_claude',
          actorType: 'agent',
        }),
      });
      return await res.json();
    }
    case 'share_app': {
      const res = await fetch(`${API_URL}/api/apps/${args.appId}/share`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      return await res.json();
    }
    case 'list_org_apps': {
      const res = await fetch(`${API_URL}/api/apps`);
      return await res.json();
    }
    case 'get_app': {
      const res = await fetch(`${API_URL}/api/apps/${args.appId}`);
      return await res.json();
    }
    case 'get_audit_log': {
      const res = await fetch(`${API_URL}/api/apps/${args.appId}/audit`);
      return await res.json();
    }
    case 'rollback_app': {
      const res = await fetch(`${API_URL}/api/apps/${args.appId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      return await res.json();
    }
    case 'set_app_secret': {
      const res = await fetch(`${API_URL}/api/apps/${args.appId}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      return await res.json();
    }
    case 'list_app_secrets': {
      const res = await fetch(`${API_URL}/api/apps/${args.appId}/secrets`);
      return await res.json();
    }
    case 'create_from_template': {
      const templateFiles: Record<string, Record<string, string>> = {
        'approval-system': {
          'index.html': '<!DOCTYPE html><html><head><title>Approval Tracker</title></head><body><h1>Approval System</h1><div id="requests"></div></body></html>',
          'server.js': 'console.log("Approval system active");',
        },
        'team-dashboard': {
          'index.html': '<!DOCTYPE html><html><head><title>Team Dashboard</title></head><body><h1>Team Metrics</h1><p>Status: All Green</p></body></html>',
        },
        'agent-langchain': {
          'app.manifest.json': '{"name":"langchain-agent","runtime":"node20","entry":"src/server.ts"}',
          'src/server.ts': 'console.log("LangChain Agent Running");',
        },
        'agent-google-adk': {
          'app.manifest.json': '{"name":"google-adk-agent","runtime":"node20","entry":"src/server.ts"}',
          'src/server.ts': 'console.log("Google ADK Agent Running");',
        },
        'agent-claude-sdk': {
          'app.manifest.json': '{"name":"claude-sdk-agent","runtime":"node20","entry":"src/server.ts"}',
          'src/server.ts': 'console.log("Claude Agent SDK Server Running");',
        },
      };

      const files = templateFiles[args.templateId] || templateFiles['approval-system'];
      const res = await fetch(`${API_URL}/api/apps/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: args.name,
          files,
          template: args.templateId,
          provider: args.provider || 'gcp',
          allowedDomains: args.allowedDomains,
          actorId: 'agent_claude',
          actorType: 'agent',
        }),
      });
      return await res.json();
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Register Official MCP SDK Handlers
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const result = await handleToolCall(request.params.name, request.params.arguments);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

async function validateApiKey(rawKey: string): Promise<{ orgId: string; scopes: string[] } | null> {
  if (!rawKey) return null;
  try {
    const res = await fetch(`${API_URL}/api/keys/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: rawKey }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.orgId) {
        return { orgId: data.orgId, scopes: data.scopes || [] };
      }
    }
  } catch (e) {
    console.error('[MCP Auth Error]:', e);
  }
  return null;
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers['authorization'] || (req.headers as any)['Authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  const tokenQuery = req.query.token || req.query.apiKey;
  if (typeof tokenQuery === 'string') {
    return tokenQuery;
  }
  return null;
}

// SSEServerTransport map for multi-session support
let sseTransports = new Map<string, SSEServerTransport>();

// 1. Official MCP SSE Endpoint (/sse)
app.get('/sse', async (req: Request, res: Response) => {
  const token = extractBearerToken(req);
  const validated = await validateApiKey(token || 'tc_live_055ac4ce735958519216c0771a874c78532a6f868e51f49d30008099605242c4');

  if (!validated && req.headers['authorization']) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API Key Bearer Token' });
  }

  const orgId = validated?.orgId || 'org_acme';
  const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  const transport = new SSEServerTransport('/message?sessionId=' + sessionId, res);
  sseTransports.set(sessionId, transport);

  req.on('close', () => {
    sseTransports.delete(sessionId);
  });

  await mcpServer.connect(transport);
});

// 2. Official MCP Message Endpoint (/message)
app.post('/message', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    // Fallback to active transport if single session
    const firstTransport = Array.from(sseTransports.values())[0];
    if (firstTransport) {
      await firstTransport.handlePostMessage(req, res);
      return;
    }
    res.status(400).json({ error: 'Session not found or expired' });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// 3. Fallback direct HTTP JSON-RPC Endpoint (/mcp & /)
app.all(['/mcp', '/'], async (req: Request, res: Response) => {
  if (req.method === 'GET') {
    return res.json({
      status: 'ok',
      service: 'cloudery-mcp',
      version: '0.1.0',
      endpoints: {
        sse: '/sse',
        jsonrpc: '/mcp',
        health: '/health'
      }
    });
  }

  const { method, params, id } = req.body || {};

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'cloudery-mcp', version: '0.1.0' },
      },
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    });
  }

  if (method === 'tools/call') {
    try {
      const toolResult = await handleToolCall(params.name, params.arguments);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
        },
      });
    } catch (err: any) {
      return res.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message },
      });
    }
  }

  return res.json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found' },
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'cloudery-mcp' }));

app.listen(PORT, () => {
  console.log(`[Cloudery MCP] Official @modelcontextprotocol/sdk Server running on http://localhost:${PORT}`);
});
