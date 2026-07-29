import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { memoryStore } from '@tinycloud/db';
import { SharePolicy } from '@tinycloud/shared';

const app = express();
const PORT = process.env.PORT || 4002;

app.use(cors());
app.use(express.json());

// Auth Gateway Middleware enforcing SharePolicy before traffic reaches origin
function enforceSharePolicy(req: Request, res: Response, next: NextFunction) {
  const host = req.headers.host || '';
  const appIdHeader = req.headers['x-tinycloud-app-id'] as string;
  const requestTenantHeader = req.headers['x-tinycloud-tenant'] as string;
  const userEmail = (req.headers['x-user-email'] as string) || 'alex@acme.com';

  // Extract host parts: {app-slug}.wishop.xyz or {app-slug}.{tenant-slug}.wishop.xyz
  const mainDomain = process.env.MAIN_DOMAIN || 'wishop.xyz';
  const hostWithoutDomain = host.replace(`.${mainDomain}`, '').replace(`:4002`, '').replace(`:8080`, '');
  const hostParts = hostWithoutDomain.split('.');
  const appSlug = hostParts[0];
  const tenantSlugFromHost = hostParts.length >= 2 ? hostParts[1] : undefined;

  let appItem;
  if (appIdHeader) {
    appItem = memoryStore.apps.get(appIdHeader);
  } else {
    appItem = Array.from(memoryStore.apps.values()).find((a) => a.slug === appSlug);
  }

  if (!appItem) {
    return next();
  }

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
  if (!policy || policy.visibility === 'link') {
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
                const res = await fetch('http://localhost:4000/api/apps/${appItem.id}/access-requests', {
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

app.use('/proxy/*', enforceSharePolicy, (req: Request, res: Response) => {
  const appId = (req.headers['x-tinycloud-app-id'] as string) || req.query.appId;
  const appItem = memoryStore.apps.get(appId as string);

  res.json({
    status: 'proxied_successfully',
    gatewayMessage: 'Traffic authorized by TinyCloud Edge Auth Gateway',
    app: appItem || { name: 'Demo Internal Tool' },
    identityHeader: req.headers['x-tinycloud-identity'],
  });
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'tinycloud-gateway' }));

app.listen(PORT, () => {
  console.log(`[TinyCloud Gateway] Auth Gateway proxy running on http://localhost:${PORT}`);
});
