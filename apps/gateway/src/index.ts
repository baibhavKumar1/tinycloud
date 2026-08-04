import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { memoryStore, dbRepository } from '@cloudery/db';
import { SharePolicy } from '@cloudery/shared';

const app = express();
const PORT = process.env.PORT || 4002;
const GCP_PROJECT_NUMBER = process.env.GCP_PROJECT_NUMBER || '1054958029786';
const GCP_REGION = process.env.GCP_REGION || 'us-central1';
const API_URL = process.env.API_URL || process.env.CONTROL_PLANE_URL || (process.env.K_SERVICE ? `https://cloudery-api-${GCP_PROJECT_NUMBER}.${GCP_REGION}.run.app` : 'http://localhost:4000');

app.use(cors());
app.use(express.json());

// Auth Gateway Middleware enforcing SharePolicy before traffic reaches origin
async function enforceSharePolicy(req: Request, res: Response, next: NextFunction) {
  const host = req.headers.host || '';
  const appIdParam = (req.headers['x-cloudery-app-id'] as string) || (req.headers['x-tinycloud-app-id'] as string) || (req.query.appId as string);
  const requestTenantHeader = (req.headers['x-cloudery-tenant'] as string) || (req.headers['x-tinycloud-tenant'] as string);
  const userEmail = (req.headers['x-user-email'] as string) || 'alex@acme.com';

  const xAgent = ((req.headers['x-agent'] as string) || '').toLowerCase();
  const xOriginalHost = ((req.headers['x-original-host'] as string) || '').toLowerCase();

  // If request is targeting a core infrastructure service (api, mcp, app, www), bypass share policy and proxy directly
  if (['api', 'mcp', 'app', 'www'].includes(xAgent) || xOriginalHost.startsWith('api.') || xOriginalHost.startsWith('mcp.') || xOriginalHost.startsWith('app.') || xOriginalHost.startsWith('www.')) {
    return next();
  }

  const targetHost = xOriginalHost || host;
  const mainDomain = process.env.MAIN_DOMAIN || 'cloudery.xyz';
  const hostWithoutDomain = targetHost.replace(`.${mainDomain}`, '').replace(`:4002`, '').replace(`:8080`, '');
  const hostParts = hostWithoutDomain.split('.');

  const targetSlug = xAgent || (hostParts.length > 0 && hostParts[0] !== 'app' && hostParts[0] !== 'api' && hostParts[0] !== 'mcp' ? hostParts[0] : null);

  let appItem = appIdParam ? await dbRepository.getAppById(appIdParam) : null;
  if (!appItem && targetSlug) {
    appItem = await dbRepository.getAppBySlug(targetSlug);
  }

  // If not in DB repository, query Control Plane API
  const targetId = appIdParam || targetSlug;
  if (!appItem && targetId) {
    try {
      const apiRes = await fetch(`${API_URL}/api/apps/${targetId}`);
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (data.app) {
          appItem = data.app;
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
  const tenantSlugFromHost = (hostParts.length >= 2) ? hostParts[1] : undefined;
  const appOrg = memoryStore.orgs.get(appItem.orgId);
  const targetTenantSlug = tenantSlugFromHost || requestTenantHeader || 'acme';
  
  if (appOrg && appOrg.slug !== targetTenantSlug) {
    memoryStore.auditEvents.push({
      id: `aud_${Date.now()}`,
      orgId: appItem.orgId,
      appId: appItem.id,
      actorId: userEmail,
      actorType: 'user',
      action: 'access_denied',
      metadata: { reason: 'tenant_mismatch', targetTenant: targetTenantSlug, appTenant: appOrg.slug },
      timestamp: new Date(),
    });
    return res.status(403).json({
      error: 'Tenant Access Denied',
      message: `App '${appItem.slug}' belongs to org '${appOrg.slug}', which cannot be accessed under tenant '${targetTenantSlug}'.`,
    });
  }

  // 2. Share Policy Visibility Rules Check
  const sharePolicy: SharePolicy = (await dbRepository.getSharePolicy(appItem.id)) || {
    id: `pol_${appItem.id}`,
    appId: appItem.id,
    orgId: appItem.orgId,
    visibility: 'public_link',
    allowedEmails: [],
    allowedDomains: ['acme.com'],
    updatedAt: new Date(),
  };

  if (sharePolicy.visibility === 'private') {
    return res.status(403).json({
      error: 'Forbidden',
      message: `App '${appItem.slug}' is set to private visibility.`,
    });
  }

  if (sharePolicy.visibility === 'org') {
    const userDomain = userEmail.split('@')[1] || '';
    const isDomainAllowed = sharePolicy.allowedDomains.includes(userDomain);
    const isEmailAllowed = sharePolicy.allowedEmails.includes(userEmail);

    if (!isDomainAllowed && !isEmailAllowed) {
      memoryStore.auditEvents.push({
        id: `aud_${Date.now()}`,
        orgId: appItem.orgId,
        appId: appItem.id,
        actorId: userEmail,
        actorType: 'user',
        action: 'access_denied',
        metadata: { reason: 'domain_not_allowed', userDomain },
        timestamp: new Date(),
      });
      return res.status(403).json({
        error: 'Access Denied by Share Policy',
        message: `Your domain '@${userDomain}' is not permitted to access this app.`,
        requestAccessUrl: `/api/apps/${appItem.id}/request-access`,
      });
    }
  }

  // Pass-through validation success: inject audit & header context
  req.headers['x-cloudery-tenant'] = targetTenantSlug;
  req.headers['x-cloudery-identity'] = userEmail;
  req.headers['x-tinycloud-tenant'] = targetTenantSlug;
  req.headers['x-tinycloud-identity'] = userEmail;

  memoryStore.auditEvents.push({
    id: `aud_${Date.now()}`,
    orgId: appItem.orgId,
    appId: appItem.id,
    actorId: userEmail,
    actorType: 'user',
    action: 'access_granted',
    metadata: { appSlug: appItem.slug, visibility: sharePolicy.visibility },
    timestamp: new Date(),
  });

  return next();
}

const handleProxyOrRoot = async (req: Request, res: Response) => {
  const host = req.headers.host || '';
  const xAgent = ((req.headers['x-agent'] as string) || '').toLowerCase();
  const xOriginalHost = ((req.headers['x-original-host'] as string) || '').toLowerCase();
  const appId = (req.headers['x-cloudery-app-id'] as string) || (req.headers['x-tinycloud-app-id'] as string) || (req.query.appId as string);

  // 1. Dispatch Core Infrastructure Services (api, mcp, app, www)
  const CORE_MAP: Record<string, string> = {
    api: process.env.API_URL || process.env.CLOUD_RUN_API_URL || `https://cloudery-api-${GCP_PROJECT_NUMBER}.${GCP_REGION}.run.app`,
    mcp: process.env.MCP_URL || process.env.CLOUD_RUN_MCP_URL || `https://cloudery-mcp-${GCP_PROJECT_NUMBER}.${GCP_REGION}.run.app`,
    app: process.env.WEB_URL || process.env.CLOUD_RUN_WEB_URL || `https://cloudery-web-${GCP_PROJECT_NUMBER}.${GCP_REGION}.run.app`,
    www: process.env.WEB_URL || process.env.CLOUD_RUN_WEB_URL || `https://cloudery-web-${GCP_PROJECT_NUMBER}.${GCP_REGION}.run.app`,
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
      appItem = await dbRepository.getAppById(appId);
    } else if (appSlug && appSlug !== 'gateway' && appSlug !== 'localhost' && !appSlug.includes('run.app')) {
      appItem = await dbRepository.getAppBySlug(appSlug);
    }
  }

  if (appItem) {
    const originUrl = (req.query.originUrl as string)
      || (req.headers['x-origin-url'] as string)
      || (appItem as any).originUrl
      || (appItem.externalRef ? `https://${appItem.externalRef}-${GCP_PROJECT_NUMBER}.${GCP_REGION}.run.app` : null);
    const reqPath = (req.query.path as string) || (req.path === '/' ? '' : req.path);

    if (originUrl && (originUrl.startsWith('http://') || originUrl.startsWith('https://'))) {
      try {
        const targetUrl = `${originUrl.replace(/\/$/, '')}${reqPath}`;
        const proxyHeaders: Record<string, string> = {
          'Content-Type': req.headers['content-type'] || 'application/json',
          'X-Cloudery-Tenant': (req.headers['x-cloudery-tenant'] as string) || (req.headers['x-tinycloud-tenant'] as string) || 'acme',
          'X-Cloudery-Identity': (req.headers['x-cloudery-identity'] as string) || (req.headers['x-tinycloud-identity'] as string) || 'alex@acme.com',
          'X-TinyCloud-Tenant': (req.headers['x-cloudery-tenant'] as string) || (req.headers['x-tinycloud-tenant'] as string) || 'acme',
          'X-TinyCloud-Identity': (req.headers['x-cloudery-identity'] as string) || (req.headers['x-tinycloud-identity'] as string) || 'alex@acme.com',
          ...(req.headers['authorization'] ? { authorization: req.headers['authorization'] as string } : {}),
        };

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
  }

  if (req.path === '/health') {
    return res.json({ status: 'ok', service: 'cloudery-gateway' });
  }

  return res.json({
    status: 'ok',
    service: 'cloudery-gateway',
    gatewayMessage: 'Cloudery Edge Auth Gateway is running',
    usage: 'Access apps via {app-slug}.cloudery.xyz or /proxy?appId={appId}'
  });
};

app.get(['/schema/v1/manifest.json', '/api/schema/v1/manifest.json'], (_req, res) => {
  res.json({
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Cloudery App Manifest',
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

app.use('/proxy/*', enforceSharePolicy, handleProxyOrRoot);
app.all('*', enforceSharePolicy, handleProxyOrRoot);

app.listen(PORT, () => {
  console.log(`[Cloudery Gateway] Auth Gateway proxy running on http://localhost:${PORT}`);
});
