import express, { Request, Response } from 'express';
import cors from 'cors';
import { memoryStore, dbRepository } from '@cloudery/db';
import { App, Deployment, SharePolicy, AuditEvent, DeployProvider } from '@cloudery/shared';
import { VercelDeployProvider } from '@cloudery/deploy-vercel';
import { GCPCloudRunDeployProvider } from '@cloudery/deploy-gcp';
import { AWSAppRunnerDeployProvider } from '@cloudery/deploy-aws';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const gcpProvider = new GCPCloudRunDeployProvider();

const providers: Record<string, DeployProvider> = {
  vercel: new VercelDeployProvider(),
  gcp: gcpProvider,
  aws: new AWSAppRunnerDeployProvider(),
};

function getShareUrl(slug: string, tenantSlug: string): string {
  const mainDomain = process.env.MAIN_DOMAIN || 'cloudery.xyz';
  return `https://${slug}.${mainDomain}`;
}

export interface ParsedRuntime {
  valid: boolean;
  runtime: string;
  language: 'python' | 'node';
  baseImage: string;
  error?: string;
}

export function validateAndParseRuntime(runtimeInput?: string, files?: Record<string, string>): ParsedRuntime {
  let runtime = (runtimeInput || '').trim().toLowerCase();

  // Extract from app.manifest.json if top-level runtime is omitted
  if (!runtime && files && files['app.manifest.json']) {
    try {
      const manifest = JSON.parse(files['app.manifest.json']);
      if (manifest.runtime) {
        runtime = String(manifest.runtime).trim().toLowerCase();
      }
    } catch (e) {}
  }

  // Fallback auto-detection if no runtime field is provided anywhere
  if (!runtime && files) {
    const hasPy = Object.keys(files).some((f) => f.endsWith('.py') || f === 'requirements.txt');
    runtime = hasPy ? 'python311' : 'node20';
  }

  if (!runtime) runtime = 'node20';

  // Strict Regex Enforcement (No Dots Allowed): python3<minor> (e.g. python311, python314) or node<ver> (e.g. node20, node24)
  const pythonMatch = runtime.match(/^python3(1[0-9]|[0-9])$/i);
  const nodeMatch = runtime.match(/^node(1[8-9]|2[0-9])$/i);

  if (pythonMatch) {
    const minor = pythonMatch[1];
    return {
      valid: true,
      runtime: `python3${minor}`,
      language: 'python',
      baseImage: `python:3.${minor}-slim`,
    };
  }

  if (nodeMatch) {
    const ver = nodeMatch[1];
    return {
      valid: true,
      runtime: `node${ver}`,
      language: 'node',
      baseImage: `node:${ver}-alpine`,
    };
  }

  return {
    valid: false,
    runtime,
    language: 'node',
    baseImage: 'node:20-alpine',
    error: `Invalid runtime format '${runtimeInput || runtime}'. Supported runtime formats MUST follow strict format without dots: 'python3<minor>' (e.g. 'python311', 'python314') or 'node<version>' (e.g. 'node20', 'node23', 'node24').`,
  };
}

// 1. Publish App endpoint (called by MCP publish_app tool)
app.post('/api/apps/publish', async (req: Request, res: Response) => {
  try {
    const { name, slug, files: rawFiles, secrets: payloadSecrets, env, template, provider: requestedProvider, visibility, allowedEmails, allowedDomains, actorId, actorType, runtime: rawRuntime } = req.body;

    // 1. Normalize `files` payload if sent as string, array, or object
    let normalizedFiles: Record<string, string> = {};
    if (typeof rawFiles === 'string') {
      try {
        normalizedFiles = JSON.parse(rawFiles);
      } catch (e) {
        console.warn('[API] Failed to parse stringified files payload:', e);
      }
    } else if (Array.isArray(rawFiles)) {
      for (const item of rawFiles) {
        if (item && item.path && item.content !== undefined) {
          normalizedFiles[item.path] = item.content;
        }
      }
    } else if (typeof rawFiles === 'object' && rawFiles !== null) {
      normalizedFiles = rawFiles;
    }

    const appSlug = slug || (name ? name.toLowerCase().replace(/[^a-z0-9]/g, '-') : 'app');

    // 2. Minimum Files Verification Gate
    const receivedFilesList = Object.keys(normalizedFiles);
    const actualCount = receivedFilesList.length;

    if (actualCount === 0) {
      const errorMsg = `Deployment rejected for app '${appSlug}': Received 0 files in upload payload. Please provide your source code files dictionary.`;
      console.warn(`[API Validation Error] ${errorMsg}`);
      return res.status(400).json({ error: errorMsg, receivedFiles: [], actualCount: 0 });
    }

    // 3. File Count Manifest Verification Gate
    if (normalizedFiles['app.manifest.json']) {
      try {
        const manifest = JSON.parse(normalizedFiles['app.manifest.json']);
        const expectedCount = manifest.filesCount ?? manifest.totalFiles ?? manifest.fileCount;

        if (typeof expectedCount === 'number' && expectedCount > 0) {
          if (actualCount !== expectedCount) {
            const errorMsg = `File count mismatch for app '${appSlug}': app.manifest.json expected ${expectedCount} files, but received ${actualCount} files in upload payload. Received files: [${receivedFilesList.join(', ')}]. Please check your upload payload.`;
            console.warn(`[API Validation Error] ${errorMsg}`);
            return res.status(400).json({
              error: errorMsg,
              receivedFiles: receivedFilesList,
              expectedCount,
              actualCount,
            });
          }
        }
      } catch (e) {}
    }

    // 4. Strict Runtime Validation & Parsing
    const runtimeInfo = validateAndParseRuntime(rawRuntime, normalizedFiles);
    if (!runtimeInfo.valid) {
      console.warn(`[API Validation Error] ${runtimeInfo.error}`);
      return res.status(400).json({ error: runtimeInfo.error, receivedFiles: receivedFilesList });
    }

    // 5. Python Entry File Verification Gate (Robust Path Normalization)
    if (runtimeInfo.language === 'python') {
      let entryFile = 'main.py';
      if (normalizedFiles['app.manifest.json']) {
        try {
          const manifest = JSON.parse(normalizedFiles['app.manifest.json']);
          if (manifest.entry) entryFile = String(manifest.entry).trim();
        } catch (e) {}
      }

      const cleanEntry = entryFile.replace(/^\.\//, '').replace(/^\//, '');

      const hasFileKey = (keyName: string) =>
        Object.prototype.hasOwnProperty.call(normalizedFiles, keyName) ||
        Object.prototype.hasOwnProperty.call(normalizedFiles, './' + keyName) ||
        Object.prototype.hasOwnProperty.call(normalizedFiles, '/' + keyName);

      let hasEntry = false;
      if (hasFileKey(cleanEntry)) {
        hasEntry = true;
      } else {
        const pyKey = Object.keys(normalizedFiles).find((f) => f.replace(/^\.\//, '').replace(/^\//, '').endsWith('.py'));
        if (pyKey) {
          hasEntry = true;
        }
      }

      if (!hasEntry) {
        const errorMsg = `Python deployment failed for app '${appSlug}': Entry file '${entryFile}' was not found in uploaded files. Received files: [${receivedFilesList.join(', ')}]. Missing: Python entry file.`;
        console.warn(`[API Validation Error] ${errorMsg}`);
        return res.status(400).json({
          error: errorMsg,
          receivedFiles: receivedFilesList,
          missingEntryFile: entryFile,
        });
      }
    }

    const activeProvider = providers[requestedProvider || 'gcp'] || providers.gcp;
    const orgId = req.body.orgId || 'org_acme';
    const org = memoryStore.orgs.get(orgId) || { id: orgId, name: 'Acme Corp', slug: 'acme' };
    const appId = `app_${appSlug}_${Date.now().toString(36)}`;
    const actor = actorId || 'agent_claude';

    // 6. Gather all secrets (payload + pre-stored) to pass into deploy
    const combinedSecrets: Record<string, string> = {};

    // 6a. Add secrets from payload
    if (typeof payloadSecrets === 'object' && payloadSecrets !== null) {
      for (const [sKey, sVal] of Object.entries(payloadSecrets)) {
        if (sKey && sVal) {
          const sId = `${appId}:production:${sKey}`;
          memoryStore.secrets.set(sId, {
            appId,
            orgId: org.id,
            key: sKey,
            value: String(sVal),
            environment: 'production',
            updatedAt: new Date(),
          });
          combinedSecrets[sKey] = String(sVal);
        }
      }
    }

    // 6b. Add pre-stored secrets for this app
    for (const secretObj of memoryStore.secrets.values()) {
      if (secretObj.appId === appId || secretObj.appId === appSlug || secretObj.appId.includes(appSlug)) {
        combinedSecrets[secretObj.key] = secretObj.value;
      }
    }

    // 7. Deploy via chosen Deploy Provider
    const projectName = appSlug;
    const deployResult = await activeProvider.deploy({
      appSlug,
      projectName,
      files: normalizedFiles,
      env,
      secrets: combinedSecrets,
      runtime: runtimeInfo.runtime,
    });

    // 9. Register App in Control Plane Source of Truth
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

    // 10. Create Deployment record
    const deploymentId = `dpl_${Date.now().toString(36)}`;
    const shareUrl = getShareUrl(appSlug, org.slug);
    const deployment: Deployment = {
      id: deploymentId,
      appId,
      orgId: org.id,
      artifactHash: `hash_${Date.now()}`,
      status: deployResult.status,
      shareUrl,
      originUrl: req.body.originUrl || deployResult.originUrl,
      externalDeploymentId: deployResult.externalDeploymentId,
      createdBy: actor,
      createdAt: new Date(),
    };
    appRecord.currentDeploymentId = deploymentId;

    // 11. Create Share Policy
    const sharePolicy: SharePolicy = {
      id: `pol_${appId}`,
      appId,
      orgId: org.id,
      visibility: visibility || 'org',
      allowedEmails: allowedEmails || [],
      allowedDomains: allowedDomains || [org.slug + '.com'],
      updatedAt: new Date(),
    };

    // Persist to Neon PostgreSQL Database
    await dbRepository.saveAppAndDeployment(appRecord, deployment, sharePolicy);

    // 12. Record Audit Event
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
        runtime: runtimeInfo.runtime,
        totalFiles: actualCount,
        filesList: receivedFilesList,
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
      runtime: runtimeInfo.runtime,
      totalFiles: actualCount,
      filesList: receivedFilesList,
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

  return res.json({
    appId: id,
    sharePolicy: updatedPolicy,
    shareUrl: getShareUrl(appRecord.slug, 'acme'),
  });
});

// 3. Request Access to Private App
app.post('/api/apps/:id/request-access', (req: Request, res: Response) => {
  const { id } = req.params;
  const { requesterEmail, reason } = req.body;

  const appRecord = memoryStore.apps.get(id);
  if (!appRecord) {
    return res.status(404).json({ error: 'App not found' });
  }

  const requestId = `req_${Date.now().toString(36)}`;
  const accessRequest = {
    id: requestId,
    appId: id,
    orgId: appRecord.orgId,
    requesterEmail: requesterEmail || 'anonymous@user.com',
    reason: reason || 'Business collaboration',
    status: 'pending',
    createdAt: new Date(),
  };

  memoryStore.accessRequests.set(requestId, accessRequest);

  // Record Audit Event
  memoryStore.auditEvents.push({
    id: `aud_${Date.now()}`,
    orgId: appRecord.orgId,
    appId: id,
    actorId: requesterEmail || 'user',
    actorType: 'user',
    action: 'access_requested',
    metadata: { requestId, reason },
    timestamp: new Date(),
  });

  return res.status(202).json({
    message: 'Access request submitted to app owner',
    accessRequest,
  });
});

// 4. Get Org App Catalog
app.get('/api/apps', async (req: Request, res: Response) => {
  const orgId = (req.query.orgId as string) || 'org_acme';
  const dbApps = await dbRepository.getAppsByOrg(orgId);
  return res.json({ apps: dbApps });
});

// 5. Get App by ID or Slug (with Cloud Run dynamic fallback resolver)
app.get('/api/apps/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  let dbApp = (await dbRepository.getAppById(id)) || (await dbRepository.getAppBySlug(id));

  // Fallback for GCP Cloud Run services if app record was cleared from memoryStore on container restart
  if (!dbApp) {
    const cleanSlug = id.replace(/^app_/, '').replace(/_[a-z0-9]+$/, '').toLowerCase();
    const serviceName = `tc-${cleanSlug}`;
    dbApp = {
      id: `app_${cleanSlug}`,
      orgId: 'org_acme',
      slug: cleanSlug,
      name: cleanSlug,
      description: 'GCP Cloud Run Service',
      shareUrl: `https://${cleanSlug}.cloudery.xyz`,
      originUrl: `https://${serviceName}-1054958029786.us-central1.run.app`,
      status: 'ready',
      visibility: 'org',
    };
    memoryStore.apps.set(dbApp.id, dbApp);
  }

  const sharePolicy = (await dbRepository.getSharePolicy(dbApp.id)) || {
    id: `pol_${dbApp.id}`,
    appId: dbApp.id,
    visibility: 'org',
    allowedEmails: [],
    allowedDomains: ['acme.com'],
  };

  return res.json({ app: dbApp, sharePolicy });
});

// 6. Get Audit Logs
app.get('/api/audit', (req: Request, res: Response) => {
  const orgId = (req.query.orgId as string) || 'org_acme';
  const events = memoryStore.auditEvents.filter((e) => e.orgId === orgId);
  return res.json({ auditEvents: events });
});

// --- APP SECRETS MANAGEMENT ENDPOINTS ---

// 7. Set or Update Secret for an App (Syncs to GCP Secret Manager & Patches Cloud Run)
app.post('/api/apps/:id/secrets', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { key, value, environment } = req.body;
  if (!key || !value) {
    return res.status(400).json({ error: 'key and value are required' });
  }
  const appRecord = (await dbRepository.getAppById(id)) || (await dbRepository.getAppBySlug(id));
  const appSlug = appRecord ? appRecord.slug : id.replace(/^app_/, '').replace(/_[a-z0-9]+$/, '');

  const env = environment || 'production';
  const secretKey = `${appRecord ? appRecord.id : id}:${env}:${key}`;

  memoryStore.secrets.set(secretKey, {
    appId: appRecord ? appRecord.id : id,
    orgId: appRecord ? appRecord.orgId : 'org_acme',
    key,
    value,
    environment: env,
    updatedAt: new Date(),
  });

  // Sync Secret to GCP Secret Manager & Patch Cloud Run Service
  console.log(`[API Secrets] Syncing secret '${key}' to GCP Secret Manager for '${appSlug}'...`);
  const synced = await gcpProvider.syncSecret(appSlug, key, value);

  return res.status(201).json({
    success: true,
    syncedToGCP: synced,
    message: `Secret '${key}' stored in GCP Secret Manager and mounted to app '${appSlug}' (${env})`,
  });
});

// 8. List Secret Keys for an App (Values Masked)
app.get('/api/apps/:id/secrets', async (req: Request, res: Response) => {
  const { id } = req.params;
  const appRecord = (await dbRepository.getAppById(id)) || (await dbRepository.getAppBySlug(id));
  const targetId = appRecord ? appRecord.id : id;

  const appSecrets: any[] = [];
  for (const [key, secretObj] of memoryStore.secrets.entries()) {
    if (secretObj.appId === targetId || secretObj.appId === id) {
      appSecrets.push({
        key: secretObj.key,
        environment: secretObj.environment,
        maskedValue: secretObj.value ? `${secretObj.value.substring(0, 3)}...****` : '****',
        updatedAt: secretObj.updatedAt,
      });
    }
  }

  return res.json({ secrets: appSecrets });
});

// 9. Delete Secret for an App
app.delete('/api/apps/:id/secrets/:key', async (req: Request, res: Response) => {
  const { id, key } = req.params;
  const appRecord = (await dbRepository.getAppById(id)) || (await dbRepository.getAppBySlug(id));
  const targetId = appRecord ? appRecord.id : id;

  const secretKey = `${targetId}:production:${key}`;
  memoryStore.secrets.delete(secretKey);

  return res.json({ success: true, message: `Secret '${key}' deleted successfully` });
});

// --- API KEY MANAGEMENT ENDPOINTS ---

// 10. Generate API Key (Returns secretToken ONCE)
app.post('/api/keys/generate', async (req: Request, res: Response) => {
  try {
    const { name, orgId, scopes } = req.body;
    const targetOrgId = orgId || 'org_acme';
    const result = await dbRepository.createApiKey(targetOrgId, name || 'API Key', scopes);
    return res.status(201).json({
      success: true,
      apiKey: result.keyRecord,
      secretToken: result.secretToken,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to generate API Key' });
  }
});

// 11. Validate API Key (Internal endpoint called by apps/mcp)
app.post('/api/keys/validate', async (req: Request, res: Response) => {
  const { apiKey } = req.body;
  if (!apiKey) {
    return res.status(400).json({ valid: false, error: 'apiKey is required' });
  }

  const authCtx = await dbRepository.validateApiKey(apiKey);
  if (!authCtx) {
    return res.status(401).json({ valid: false, error: 'Invalid or revoked API key' });
  }

  return res.json({ valid: true, orgId: authCtx.orgId, scopes: authCtx.scopes });
});

// 12. List API Keys for Org
app.get('/api/keys', async (req: Request, res: Response) => {
  const orgId = (req.query.orgId as string) || 'org_acme';
  const keys = await dbRepository.listApiKeys(orgId);
  return res.json({ apiKeys: keys });
});

// 13. Revoke API Key
app.delete('/api/keys/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  await dbRepository.revokeApiKey(id);
  return res.json({ success: true, message: `API Key ${id} revoked successfully` });
});

// 14. Health Check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'cloudery-api' });
});

app.listen(PORT, () => {
  console.log(`[Cloudery API] Control plane running on http://localhost:${PORT}`);
});
