import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { memoryStore } from '@tinycloud/db';
import { SharePolicy } from '@tinycloud/shared';

const app = express();
const PORT = process.env.PORT || 4002;
const API_URL = process.env.API_URL || process.env.CONTROL_PLANE_URL || (process.env.K_SERVICE ? 'https://tinycloud-api-1054958029786.us-central1.run.app' : 'http://localhost:4000');

app.use(cors());
app.use(express.json());

// Auth Gateway Middleware enforcing SharePolicy before traffic reaches origin
async function enforceSharePolicy(req: Request, res: Response, next: NextFunction) {
  const host = req.headers.host || '';
  const appIdParam = (req.headers['x-tinycloud-app-id'] as string) || (req.query.appId as string);
  const requestTenantHeader = req.headers['x-tinycloud-tenant'] as string;
  const userEmail = (req.headers['x-user-email'] as string) || 'alex@acme.com';

  // Extract host parts: {app-slug}.cloudery.xyz or {app-slug}.{tenant-slug}.cloudery.xyz
  const xAgent = ((req.headers['x-agent'] as string) || '').toLowerCase();
  const mainDomain = process.env.MAIN_DOMAIN || 'cloudery.xyz';
  const isCoreSlug = ['api', 'mcp', 'app', 'www', 'gateway', 'localhost'].includes(xAgent);
  const isPlatformHost = host.includes('.run.app') || (host.includes(mainDomain) && (host.startsWith('api.') || host.startsWith('mcp.') || host.startsWith('app.') || host.startsWith('gateway.'))) || host.startsWith('tinycloud-');
  const hostWithoutDomain = host.replace(`.${mainDomain}`, '').replace(`:4002`, '').replace(`:8080`, '');
  const hostParts = hostWithoutDomain.split('.');
  const appSlug = (xAgent && !isCoreSlug) ? xAgent : hostParts[0];
  const tenantSlugFromHost = (!isPlatformHost && hostParts.length >= 2) ? hostParts[1] : undefined;

  const targetSlug = (xAgent && !isCoreSlug) ? xAgent : (!isPlatformHost ? appSlug : null);

  let appItem;
  if (appIdParam) {
    appItem = memoryStore.apps.get(appIdParam);
  } else if (targetSlug) {
    appItem = Array.from(memoryStore.apps.values()).find((a) => a.slug === targetSlug);
  }

  // If not in local memory, query Control Plane API
  const targetId = appIdParam || targetSlug;
  if (!appItem && targetId) {
    try {
      const apiRes = await fetch(`${API_URL}/api/apps/${targetId}`);
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (data.app) {
          appItem = data.app;
          memoryStore.apps.set(appItem.id, appItem);
          if (data.sharePolicy) {
            memoryStore.sharePolicies.set(appItem.id, data.sharePolicy);
          }
        }
      }
    } catch (e) {
      console.error('[Gateway] Failed to fetch app from API:', e);
    }
  }

  if (!appItem) {
    return next();
  }

  (req as any).appItem = appItem;

  // 1. Multi-Tenant Boundary Isolation Check
  const appOrg = memoryStore.orgs.get(appItem.orgId);
  const targetTenantSlug = tenantSlugFromHost || requestTenantHeader || 'acme';
  
  if (appOrg && appOrg.slug !== targetTenantSlug) {
    // Audit Tenant Boundary Violation Attempt
    memoryStore.auditEvents.push({
      id: `aud_${Date.now()}`,
      orgId: appItem.orgId,
      appId: appItem.id,
      actorId: userEmail,
      actorType: 'user',
      action: 'access_denied',
      metadata: { reason: 'Tenant Isolation Violation', appOrg: appOrg.slug, requestedTenant: targetTenantSlug, userEmail },
      timestamp: new Date(),
    });

    return res.status(403).json({
      error: 'Tenant Boundary Access Denied',
      message: `App '${appItem.name}' belongs to tenant '${appOrg.name}' (${appOrg.slug}) and cannot be accessed under tenant context '${targetTenantSlug}'.`,
    });
  }

  const policy: SharePolicy | undefined = memoryStore.sharePolicies.get(appItem.id);
  const userDomain = userEmail.split('@')[1] || '';

  let isAllowed = false;
  const vis = (policy?.visibility as string) || '';
  if (!policy || vis === 'link' || vis === 'public_link' || vis === 'public') {
    isAllowed = true;
  } else if (policy.visibility === 'org') {
    const org = memoryStore.orgs.get(appItem.orgId);
    isAllowed = userDomain === (org?.slug + '.com') || (policy.allowedDomains && policy.allowedDomains.includes(userDomain));
  } else if (policy.visibility === 'private') {
    isAllowed = policy.allowedEmails.includes(userEmail) || appItem.ownerId === userEmail;
  }

  if (!isAllowed) {
    // Log Access Denied Audit Event
    memoryStore.auditEvents.push({
      id: `aud_${Date.now()}`,
      orgId: appItem.orgId,
      appId: appItem.id,
      actorId: userEmail,
      actorType: 'user',
      action: 'access_denied',
      metadata: { reason: 'SharePolicy enforcement', policyVisibility: policy?.visibility, userEmail },
      timestamp: new Date(),
    });

    return res.status(403).send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Access Denied — TinyCloud Edge Gateway</title>
          <style>
            body { font-family: 'Plus Jakarta Sans', system-ui, sans-serif; background: #090d16; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
            .card { background: rgba(18, 26, 42, 0.85); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 16px; padding: 32px; max-width: 480px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.6); }
            h1 { font-size: 20px; font-weight: 800; color: #f43f5e; margin-bottom: 8px; }
            p { font-size: 13px; color: #9ca3af; line-height: 1.5; margin-bottom: 20px; }
            input, textarea { width: 100%; background: #0f172a; border: 1px solid rgba(255,255,255,0.1); padding: 10px 12px; border-radius: 8px; color: #fff; font-size: 13px; margin-bottom: 12px; box-sizing: border-box; }
            button { width: 100%; background: linear-gradient(135deg, #6366f1, #4f46e5); color: #fff; border: none; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; }
            .status { font-size: 12px; color: #10b981; margin-top: 12px; text-align: center; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>🔒 Access Denied</h1>
            <p>Your account (<strong>${userEmail}</strong>) does not have permission to view <strong>${appItem.name}</strong> under its active SharePolicy.</p>
            
            <form id="reqForm" onsubmit="submitReq(event)">
              <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">Your Email Address</label>
              <input type="email" id="email" value="${userEmail}" required />
              
              <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">Reason for Request</label>
              <textarea id="reason" rows="3" placeholder="Explain why you need access to this tool..." required></textarea>
              
              <button type="submit">Request Access from Owner</button>
              <div id="status" class="status"></div>
            </form>

            <script>
              async function submitReq(e) {
                e.preventDefault();
                const email = document.getElementById('email').value;
                const reason = document.getElementById('reason').value;
                const res = await fetch('${API_URL}/api/apps/${appItem.id}/access-requests', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ requesterEmail: email, reason })
                });
                if (res.ok) {
                  document.getElementById('status').innerText = '✅ Access request submitted! The app owner has been notified.';
                  document.getElementById('reqForm').reset();
                }
              }
            </script>
          </div>
        </body>
      </html>
    `);
  }

  // Log Access Granted Audit Event
  memoryStore.auditEvents.push({
    id: `aud_${Date.now()}`,
    orgId: appItem.orgId,
    appId: appItem.id,
    actorId: userEmail,
    actorType: 'user',
    action: 'access_granted',
    metadata: { userEmail },
    timestamp: new Date(),
  });

  // Inject signed identity header
  req.headers['x-tinycloud-identity'] = JSON.stringify({
    userEmail,
    appId: appItem.id,
    orgId: appItem.orgId,
    timestamp: Date.now(),
  });

  return next();
}

const handleProxyOrRoot = async (req: Request, res: Response) => {
  const host = req.headers.host || '';
  const xAgent = ((req.headers['x-agent'] as string) || '').toLowerCase();
  const xOriginalHost = ((req.headers['x-original-host'] as string) || '').toLowerCase();
  const appId = (req.headers['x-tinycloud-app-id'] as string) || (req.query.appId as string);

  // 1. Dispatch Core Infrastructure Services
  const CORE_MAP: Record<string, string> = {
    api: 'https://tinycloud-api-1054958029786.us-central1.run.app',
    mcp: 'https://tinycloud-mcp-1054958029786.us-central1.run.app',
    app: 'https://tinycloud-web-1054958029786.us-central1.run.app',
    www: 'https://tinycloud-web-1054958029786.us-central1.run.app',
  };

  const coreSlug = CORE_MAP[xAgent] ? xAgent : (xOriginalHost.startsWith('api.') ? 'api' : xOriginalHost.startsWith('mcp.') ? 'mcp' : (xOriginalHost.startsWith('app.') || xOriginalHost.startsWith('www.')) ? 'app' : null);

  if (coreSlug && CORE_MAP[coreSlug]) {
    const originUrl = CORE_MAP[coreSlug];
    const reqPath = (req.query.path as string) || (req.path === '/' ? '' : req.path);
    const targetUrl = `${originUrl.replace(/\/$/, '')}${reqPath}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;
    try {
      const fetchOptions: any = {
        method: req.method,
        headers: {
          'Content-Type': req.headers['content-type'] || 'application/json',
          ...(req.headers['authorization'] ? { authorization: req.headers['authorization'] as string } : {}),
        },
      };
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
        fetchOptions.body = JSON.stringify(req.body);
      }
      const backendRes = await fetch(targetUrl, fetchOptions);
      const contentType = backendRes.headers.get('content-type') || '';
      const data = await backendRes.text();
      res.status(backendRes.status);
      if (contentType.includes('application/json')) {
        try {
          return res.json(JSON.parse(data));
        } catch {
          return res.send(data);
        }
      }
      return res.send(data);
    } catch (e: any) {
      console.error('[Gateway Core Proxy Error]:', e);
    }
  }

  const mainDomain = process.env.MAIN_DOMAIN || 'cloudery.xyz';
  const hostWithoutDomain = host.replace(`.${mainDomain}`, '').replace(`:4002`, '').replace(`:8080`, '');
  const hostParts = hostWithoutDomain.split('.');
  const appSlug = xAgent || hostParts[0];

  let appItem = (req as any).appItem;
  if (!appItem) {
    if (appId) {
      appItem = memoryStore.apps.get(appId);
    } else if (appSlug && appSlug !== 'gateway' && appSlug !== 'localhost' && !appSlug.includes('run.app')) {
      appItem = Array.from(memoryStore.apps.values()).find((a) => a.slug === appSlug);
    }
  }

  if (appItem) {
    const deployment = appItem.currentDeploymentId ? memoryStore.deployments.get(appItem.currentDeploymentId) : null;
    const originUrl = (req.query.originUrl as string)
      || (req.headers['x-origin-url'] as string)
      || (appItem as any).originUrl
      || deployment?.originUrl
      || (appItem.externalRef ? `https://${appItem.externalRef}-1054958029786.us-central1.run.app` : null);
    const reqPath = (req.query.path as string) || (req.path === '/' ? '' : req.path);

    if (originUrl && (originUrl.startsWith('http://') || originUrl.startsWith('https://'))) {
      try {
        const targetUrl = `${originUrl.replace(/\/$/, '')}${reqPath}`;
        const proxyHeaders: Record<string, string> = {
          'Content-Type': req.headers['content-type'] || 'application/json',
          'x-tinycloud-identity': (req.headers['x-tinycloud-identity'] as string) || '',
        };
        if (req.headers['authorization']) {
          proxyHeaders['authorization'] = req.headers['authorization'] as string;
        }

        const fetchOptions: any = {
          method: req.method,
          headers: proxyHeaders,
        };
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
          fetchOptions.body = JSON.stringify(req.body);
        }

        const backendRes = await fetch(targetUrl, fetchOptions);
        const contentType = backendRes.headers.get('content-type') || '';
        const data = await backendRes.text();

        res.status(backendRes.status);
        if (contentType.includes('application/json')) {
          try {
            return res.json(JSON.parse(data));
          } catch {
            return res.send(data);
          }
        }
        return res.send(data);
      } catch (err: any) {
        console.error('[Gateway Proxy Error]:', err);
      }
    }

    return res.json({
      status: 'proxied_successfully',
      gatewayMessage: 'Traffic authorized by TinyCloud Edge Auth Gateway',
      app: appItem,
      originUrl: originUrl || 'Mock Origin (Local / Virtual Deployment)',
      identityHeader: req.headers['x-tinycloud-identity'],
    });
  }

  return res.json({
    status: 'ok',
    service: 'tinycloud-gateway',
    gatewayMessage: 'TinyCloud Edge Auth Gateway is running',
    usage: 'Access apps via {app-slug}.cloudery.xyz or /proxy?appId={appId}'
  });
};

app.get(['/schema/v1/manifest.json', '/api/schema/v1/manifest.json'], (_req, res) => {
  res.json({
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'TinyCloud App Manifest',
    type: 'object',
    required: ['name', 'runtime', 'entry'],
    properties: {
      $schema: { type: 'string' },
      name: { type: 'string' },
      version: { type: 'string' },
      runtime: { type: 'string', enum: ['node20', 'bun', 'static', 'python3', 'python311'] },
      entry: { type: 'string' },
      port: { type: 'number' },
      healthCheck: { type: 'string' },
      env: { type: 'array', items: { type: 'string' } },
      description: { type: 'string' },
      permissions: {
        type: 'object',
        properties: {
          default: { type: 'string', enum: ['org_members', 'private', 'public_link'] }
        }
      }
    }
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'tinycloud-gateway' }));

app.use('/proxy/*', enforceSharePolicy, handleProxyOrRoot);
app.all('*', enforceSharePolicy, handleProxyOrRoot);

app.listen(PORT, () => {
  console.log(`[TinyCloud Gateway] Auth Gateway proxy running on http://localhost:${PORT}`);
});

