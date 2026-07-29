import express, { Request, Response } from 'express';
import cors from 'cors';
import { memoryStore } from '@tinycloud/db';
import { VercelDeployProvider } from '@tinycloud/deploy-vercel';
import { GCPCloudRunDeployProvider } from '@tinycloud/deploy-gcp';
import { AWSAppRunnerDeployProvider } from '@tinycloud/deploy-aws';
import { SharePolicy, App, Deployment, AuditEvent, Secret, AccessRequest, DeployProvider } from '@tinycloud/shared';

const app = express();
const PORT = process.env.PORT || 4000;

const providers: Record<string, DeployProvider> = {
  vercel: new VercelDeployProvider(),
  gcp: new GCPCloudRunDeployProvider(),
  aws: new AWSAppRunnerDeployProvider(),
};

app.use(cors());
app.use(express.json());

// Helper for generating share URLs
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'tinycloud.app';
function getShareUrl(slug: string, orgSlug: string): string {
  return `https://${slug}.${orgSlug}.${BASE_DOMAIN}`;
}

// 1. Publish App endpoint (called by MCP publish_app tool)
app.post('/api/apps/publish', async (req: Request, res: Response) => {
  try {
    const { name, slug, files, env, template, provider: requestedProvider, visibility, allowedEmails, allowedDomains, actorId, actorType } = req.body;

    const activeProvider = providers[requestedProvider || 'vercel'] || providers.vercel;
    const orgId = req.body.orgId || 'org_acme';
    const org = memoryStore.orgs.get(orgId) || { id: orgId, name: 'Acme Corp', slug: 'acme' };
    const appSlug = slug || name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const appId = `app_${appSlug}_${Date.now().toString(36)}`;
    const actor = actorId || 'agent_claude';

    // 1. Create or link project via chosen Deploy Provider (Vercel, GCP, AWS)
    const projectName = `tc-${org.slug}-${appSlug}`;
    const deployResult = await activeProvider.deploy({
      appSlug,
      projectName,
      files: files || { 'index.html': '<h1>TinyCloud App</h1>' },
      env,
    });

    // 2. Register App in Control Plane Source of Truth
    const appRecord: App = {
      id: appId,
      orgId: org.id,
      slug: appSlug,
      name,
      description: req.body.description || `App deployed via ${actorType || 'agent'}`,
      ownerId: actor,
      externalRef: deployResult.externalProjectId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    memoryStore.apps.set(appId, appRecord);

    // 3. Create Deployment record
    const deploymentId = `dpl_${Date.now().toString(36)}`;
    const shareUrl = getShareUrl(appSlug, org.slug);
    const deployment: Deployment = {
      id: deploymentId,
      appId,
      orgId: org.id,
      artifactHash: `hash_${Date.now()}`,
      status: deployResult.status,
      shareUrl,
      originUrl: deployResult.originUrl,
      externalDeploymentId: deployResult.externalDeploymentId,
      createdBy: actor,
      createdAt: new Date(),
    };
    memoryStore.deployments.set(deploymentId, deployment);
    appRecord.currentDeploymentId = deploymentId;

    // 4. Create Share Policy
    const sharePolicy: SharePolicy = {
      id: `pol_${appId}`,
      appId,
      orgId: org.id,
      visibility: visibility || 'org',
      allowedEmails: allowedEmails || [],
      allowedDomains: allowedDomains || [org.slug + '.com'],
      updatedAt: new Date(),
    };
    memoryStore.sharePolicies.set(appId, sharePolicy);

    // 5. Record Audit Event
    const auditEvent: AuditEvent = {
      id: `aud_${Date.now()}`,
      orgId: org.id,
      appId,
      actorId: actor,
      actorType: actorType || 'agent',
      action: 'deploy',
      metadata: {
        appName: name,
        template,
        provider: activeProvider.name,
        visibility: sharePolicy.visibility,
        originUrl: deployResult.originUrl,
      },
      timestamp: new Date(),
    };
    memoryStore.auditEvents.push(auditEvent);

    return res.status(201).json({
      appId,
      name,
      slug: appSlug,
      shareUrl,
      status: deployment.status,
      sharePolicy,
      catalogEntry: {
        id: appId,
        name,
        shareUrl,
        owner: actor,
        lastDeployed: deployment.createdAt,
      },
    });
  } catch (error: any) {
    console.error('[API] Publish app failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to publish app' });
  }
});

// 2. Update Share Policy
app.patch('/api/apps/:id/share', (req: Request, res: Response) => {
  const { id } = req.params;
  const { visibility, allowedEmails, allowedDomains, actorId } = req.body;

  const appRecord = memoryStore.apps.get(id);
  if (!appRecord) {
    return res.status(404).json({ error: 'App not found' });
  }

  const existingPolicy = memoryStore.sharePolicies.get(id) || {
    id: `pol_${id}`,
    appId: id,
    visibility: 'org',
    allowedEmails: [],
    allowedDomains: [],
    updatedAt: new Date(),
  };

  const updatedPolicy: SharePolicy = {
    ...existingPolicy,
    visibility: visibility || existingPolicy.visibility,
    allowedEmails: allowedEmails !== undefined ? allowedEmails : existingPolicy.allowedEmails,
    allowedDomains: allowedDomains !== undefined ? allowedDomains : existingPolicy.allowedDomains,
    updatedAt: new Date(),
  };
  memoryStore.sharePolicies.set(id, updatedPolicy);

  // Record Audit Event
  memoryStore.auditEvents.push({
    id: `aud_${Date.now()}`,
    orgId: appRecord.orgId,
    appId: id,
    actorId: actorId || 'user',
    actorType: 'user',
    action: 'share_policy_change',
    metadata: { visibility: updatedPolicy.visibility, allowedEmails: updatedPolicy.allowedEmails, allowedDomains: updatedPolicy.allowedDomains },
    timestamp: new Date(),
  });

  return res.json({ success: true, sharePolicy: updatedPolicy });
});

// 3. List Org Apps Catalog
app.get('/api/apps', (req: Request, res: Response) => {
  const appsList = Array.from(memoryStore.apps.values()).map((appItem: App) => {
    const policy = memoryStore.sharePolicies.get(appItem.id);
    const deployment = appItem.currentDeploymentId ? memoryStore.deployments.get(appItem.currentDeploymentId) : null;
    const org = memoryStore.orgs.get(appItem.orgId) || { slug: 'acme' };
    return {
      ...appItem,
      shareUrl: getShareUrl(appItem.slug, org.slug),
      visibility: policy?.visibility || 'org',
      status: deployment?.status || 'ready',
    };
  });
  return res.json({ apps: appsList });
});

// 4. Get App Details
app.get('/api/apps/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const appItem = memoryStore.apps.get(id);
  if (!appItem) {
    return res.status(404).json({ error: 'App not found' });
  }

  const policy = memoryStore.sharePolicies.get(id);
  const deployment = appItem.currentDeploymentId ? memoryStore.deployments.get(appItem.currentDeploymentId) : null;
  const org = memoryStore.orgs.get(appItem.orgId) || { slug: 'acme' };

  return res.json({
    app: appItem,
    shareUrl: getShareUrl(appItem.slug, org.slug),
    sharePolicy: policy,
    currentDeployment: deployment,
  });
});

// 5. Secret & Environment Variable Management Endpoints
app.post('/api/apps/:id/secrets', (req: Request, res: Response) => {
  const { id } = req.params;
  const { key, value, environment: envName } = req.body;
  const orgId = (req.headers['x-tinycloud-tenant'] as string) || req.body.orgId || 'org_acme';
  const environment = envName || 'production';

  const appRecord = memoryStore.apps.get(id);
  if (!appRecord || appRecord.orgId !== orgId) {
    return res.status(404).json({ error: 'App not found under this tenant' });
  }

  // Encrypt secret value (simple base64 / cipher abstraction)
  const encryptedValue = Buffer.from(value).toString('base64');
  const secretId = `${id}:${environment}:${key}`;
  const secretRecord: Secret = {
    id: secretId,
    appId: id,
    orgId,
    environment,
    key,
    encryptedValue,
    updatedAt: new Date(),
  };

  memoryStore.secrets.set(secretId, secretRecord);

  // Record Audit Event
  memoryStore.auditEvents.push({
    id: `aud_${Date.now()}`,
    orgId,
    appId: id,
    actorId: req.body.actorId || 'operator',
    actorType: 'user',
    action: 'secret_updated',
    metadata: { key, environment },
    timestamp: new Date(),
  });

  return res.status(201).json({ success: true, key, environment, updatedAt: secretRecord.updatedAt });
});

app.get('/api/apps/:id/secrets', (req: Request, res: Response) => {
  const { id } = req.params;
  const orgId = (req.headers['x-tinycloud-tenant'] as string) || (req.query.orgId as string) || 'org_acme';

  const appRecord = memoryStore.apps.get(id);
  if (!appRecord || appRecord.orgId !== orgId) {
    return res.status(404).json({ error: 'App not found under this tenant' });
  }

  const appSecrets = Array.from(memoryStore.secrets.values())
    .filter((s: Secret) => s.appId === id && s.orgId === orgId)
    .map((s: Secret) => ({
      id: s.id,
      key: s.key,
      environment: s.environment,
      maskedValue: '••••••••••••',
      updatedAt: s.updatedAt,
    }));

  return res.json({ secrets: appSecrets });
});

// 7. Access Request Endpoints
app.post('/api/apps/:id/access-requests', (req: Request, res: Response) => {
  const { id } = req.params;
  const { requesterEmail, reason } = req.body;
  const appRecord = memoryStore.apps.get(id);
  if (!appRecord) {
    return res.status(404).json({ error: 'App not found' });
  }

  const requestId = `req_${Date.now().toString(36)}`;
  const accessReq: AccessRequest = {
    id: requestId,
    appId: id,
    orgId: appRecord.orgId,
    requesterEmail: requesterEmail || 'guest@external.com',
    reason: reason || 'Access requested by user',
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  memoryStore.accessRequests.set(requestId, accessReq);

  // Record Audit Event
  memoryStore.auditEvents.push({
    id: `aud_${Date.now()}`,
    orgId: appRecord.orgId,
    appId: id,
    actorId: accessReq.requesterEmail,
    actorType: 'user',
    action: 'access_requested',
    metadata: { reason, requestId },
    timestamp: new Date(),
  });

  return res.status(201).json({ success: true, accessRequest: accessReq });
});

app.get('/api/apps/:id/access-requests', (req: Request, res: Response) => {
  const { id } = req.params;
  const requests = Array.from(memoryStore.accessRequests.values()).filter((r: AccessRequest) => r.appId === id);
  return res.json({ accessRequests: requests });
});

app.post('/api/apps/:id/access-requests/:requestId/approve', (req: Request, res: Response) => {
  const { id, requestId } = req.params;
  const accessReq = memoryStore.accessRequests.get(requestId);
  if (!accessReq || accessReq.appId !== id) {
    return res.status(404).json({ error: 'Access request not found' });
  }

  accessReq.status = 'approved';
  accessReq.updatedAt = new Date();

  // Add requester email to app SharePolicy.allowedEmails
  const policy = memoryStore.sharePolicies.get(id);
  if (policy) {
    if (!policy.allowedEmails.includes(accessReq.requesterEmail)) {
      policy.allowedEmails.push(accessReq.requesterEmail);
    }
  }

  memoryStore.auditEvents.push({
    id: `aud_${Date.now()}`,
    orgId: accessReq.orgId,
    appId: id,
    actorId: req.body.approverId || 'admin',
    actorType: 'user',
    action: 'access_approved',
    metadata: { approvedEmail: accessReq.requesterEmail },
    timestamp: new Date(),
  });

  return res.json({ success: true, accessRequest: accessReq });
});

app.post('/api/apps/:id/access-requests/:requestId/reject', (req: Request, res: Response) => {
  const { id, requestId } = req.params;
  const accessReq = memoryStore.accessRequests.get(requestId);
  if (!accessReq || accessReq.appId !== id) {
    return res.status(404).json({ error: 'Access request not found' });
  }

  accessReq.status = 'rejected';
  accessReq.updatedAt = new Date();

  memoryStore.auditEvents.push({
    id: `aud_${Date.now()}`,
    orgId: accessReq.orgId,
    appId: id,
    actorId: req.body.rejecterId || 'admin',
    actorType: 'user',
    action: 'access_rejected',
    metadata: { rejectedEmail: accessReq.requesterEmail },
    timestamp: new Date(),
  });

  return res.json({ success: true, accessRequest: accessReq });
});

// 6. Rollback App
app.post('/api/apps/:id/rollback', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { targetDeploymentId, provider: requestedProvider } = req.body;
  const appRecord = memoryStore.apps.get(id);
  if (!appRecord) {
    return res.status(404).json({ error: 'App not found' });
  }

  const activeProvider = providers[requestedProvider || 'vercel'] || providers.vercel;
  if (appRecord.externalRef && targetDeploymentId) {
    await activeProvider.rollback(appRecord.externalRef, targetDeploymentId);
  }

  appRecord.currentDeploymentId = targetDeploymentId || appRecord.currentDeploymentId;

  memoryStore.auditEvents.push({
    id: `aud_${Date.now()}`,
    orgId: appRecord.orgId,
    appId: id,
    actorId: req.body.actorId || 'operator',
    actorType: 'user',
    action: 'rollback',
    metadata: { targetDeploymentId, provider: activeProvider.name },
    timestamp: new Date(),
  });

  return res.json({ success: true, currentDeploymentId: appRecord.currentDeploymentId });
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'tinycloud-api' });
});

app.listen(PORT, () => {
  console.log(`[TinyCloud API] Control plane running on http://localhost:${PORT}`);
});
