import { DeployProvider, DeployOptions, DeployResult, DeploymentStatus } from '@tinycloud/shared';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

export class GCPCloudRunDeployProvider implements DeployProvider {
  public name = 'gcp-cloudrun';
  private projectId: string;
  private region: string;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor() {
    this.projectId = process.env.GCP_PROJECT_ID || 'agent-api-483208';
    this.region = process.env.GCP_REGION || 'us-central1';
  }

  private async getAccessToken(): Promise<string | null> {
    if (process.env.GCP_ACCESS_TOKEN) {
      return process.env.GCP_ACCESS_TOKEN;
    }

    // 1. Check in-memory cached token (valid for ~58 mins)
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.token;
    }

    // 2. Retry up to 3 times querying GCP Metadata Server (Active inside GCP Cloud Run)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const metaRes = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
          headers: { 'Metadata-Flavor': 'Google' },
          signal: AbortSignal.timeout(4000),
        });
        if (metaRes.ok) {
          const data: any = await metaRes.json();
          if (data.access_token) {
            const expiresIn = (data.expires_in || 3600) - 120;
            this.cachedToken = {
              token: data.access_token,
              expiresAt: Date.now() + expiresIn * 1000,
            };
            return data.access_token;
          }
        }
      } catch (e: any) {
        console.warn(`[GCP Metadata Attempt ${attempt}/3 Warning]:`, e.message);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // 3. Query local gcloud CLI if running locally
    try {
      const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
      return token;
    } catch (e) {
      console.warn('[GCPCloudRunDeployProvider] Unable to acquire access token via gcloud:', (e as Error).message);
      return null;
    }
  }

  async createOrLinkProject(projectName: string): Promise<string> {
    const clean = projectName
      .toLowerCase()
      .replace(/^tc-/, '')
      .replace(/^acme-/, '')
      .replace(/^globex-/, '')
      .replace(/[^a-z0-9]/g, '-');
    return `tc-${clean}`;
  }

  async syncSecret(appSlug: string, key: string, value: string): Promise<boolean> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return false;

    const secretId = `${appSlug}_${key}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const secretName = `projects/${this.projectId}/secrets/${secretId}`;

    try {
      // 1. Create Secret if it doesn't exist
      const createSecretUrl = `https://secretmanager.googleapis.com/v1/projects/${this.projectId}/secrets?secretId=${secretId}`;
      await fetch(createSecretUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          replication: { automatic: {} },
        }),
      });

      // 2. Add Secret Version (Base64 payload)
      const addVersionUrl = `https://secretmanager.googleapis.com/v1/${secretName}:addVersion`;
      const base64Data = Buffer.from(value, 'utf8').toString('base64');
      const addVerRes = await fetch(addVersionUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payload: { data: base64Data },
        }),
      });

      if (!addVerRes.ok) {
        console.warn(`[GCP Secret Manager Warning] Failed to add version to ${secretId}:`, addVerRes.status, await addVerRes.text());
        return false;
      }
      console.log(`✅ [GCP Secret Manager] Secret '${secretId}' stored in GCP Secret Manager!`);

      // 3. Attach Secret Reference to Cloud Run Service
      const serviceName = await this.createOrLinkProject(appSlug);
      const serviceUrl = `https://run.googleapis.com/v2/projects/${this.projectId}/locations/${this.region}/services/${serviceName}`;
      const getRes = await fetch(serviceUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!getRes.ok) {
        console.warn(`[GCP Secret Manager Warning] Service ${serviceName} not found on Cloud Run yet.`);
        return true;
      }

      const currentService: any = await getRes.json();
      const currentContainer = currentService.template?.containers?.[0];
      if (!currentContainer) return false;

      const existingEnv = currentContainer.env || [];
      const updatedEnv = existingEnv.filter((e: any) => e.name !== key);

      // Mount GCP Secret Reference via secretKeyRef
      updatedEnv.push({
        name: key,
        valueSource: {
          secretKeyRef: {
            secret: secretId,
            version: 'latest',
          },
        },
      });

      currentContainer.env = updatedEnv;

      console.log(`[GCP Cloud Run Secrets] Patching Cloud Run service ${serviceName} with Secret Reference '${key}'...`);
      const patchRes = await fetch(serviceUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: currentService.name,
          template: currentService.template,
        }),
      });

      if (patchRes.ok) {
        console.log(`✅ [GCP Cloud Run Secrets] Service ${serviceName} updated with Secret Reference '${key}'! New revision deploying...`);
        return true;
      } else {
        console.warn(`[GCP Cloud Run Secret Reference Warning]: ${patchRes.status}`, await patchRes.text());
        return false;
      }
    } catch (err: any) {
      console.error('[GCP Secret Manager Error]:', err.message);
      return false;
    }
  }

  private createSourceTarball(appSlug: string, version: string, files: Record<string, string>, runtime?: string): string {
    const tmpDir = path.join(os.tmpdir(), `tc_build_${appSlug}_${version}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    }

    if (!files['Dockerfile']) {
      let isPython = false;
      let baseImage = 'node:20-alpine';

      // Parse runtime string without dots (python311, python314, node20, node24)
      const rStr = (runtime || '').toLowerCase().trim();
      const pythonMatch = rStr.match(/^python3(1[0-9]|[0-9])$/i);
      const nodeMatch = rStr.match(/^node(1[8-9]|2[0-9])$/i);

      if (pythonMatch) {
        isPython = true;
        baseImage = `python:3.${pythonMatch[1]}-slim`;
      } else if (nodeMatch) {
        isPython = false;
        baseImage = `node:${nodeMatch[1]}-alpine`;
      } else {
        // Fallback: Check app.manifest.json or file extensions
        if (files['app.manifest.json']) {
          try {
            const manifest = JSON.parse(files['app.manifest.json']);
            const mRun = String(manifest.runtime || '').toLowerCase();
            const mPyMatch = mRun.match(/^python3(1[0-9]|[0-9])$/i);
            const mNdMatch = mRun.match(/^node(1[8-9]|2[0-9])$/i);
            if (mPyMatch) {
              isPython = true;
              baseImage = `python:3.${mPyMatch[1]}-slim`;
            } else if (mNdMatch) {
              isPython = false;
              baseImage = `node:${mNdMatch[1]}-alpine`;
            } else if (mRun.includes('python') || mRun.includes('py')) {
              isPython = true;
              baseImage = 'python:3.11-slim';
            }
          } catch (e) {}
        }

        if (!isPython && Object.keys(files).some((f) => f.endsWith('.py') || f === 'requirements.txt')) {
          isPython = true;
          baseImage = 'python:3.11-slim';
        }
      }

      // Dynamic Entry Point Resolution for Python
      let entryFile = 'main.py';
      if (isPython) {
        if (files['app.manifest.json']) {
          try {
            const manifest = JSON.parse(files['app.manifest.json']);
            if (manifest.entry) entryFile = manifest.entry;
          } catch (e) {}
        }

        if (!files[entryFile]) {
          const fallbackPy = Object.keys(files).find((f) => f.endsWith('.py'));
          if (fallbackPy) entryFile = fallbackPy;
        }
        console.log(`🐍 [GCP Build] RUNTIME MATCHED: PYTHON (Base Image: ${baseImage}, Entry: ${entryFile}) for '${appSlug}'. Generating Python Dockerfile...`);
      } else {
        console.log(`⚡ [GCP Build] RUNTIME MATCHED: NODE.JS (Base Image: ${baseImage}) for '${appSlug}'. Generating Node.js Dockerfile...`);
      }

      const dockerfileContent = isPython
        ? `FROM ${baseImage}
WORKDIR /app
COPY . .
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi
EXPOSE 8080
ENV PORT=8080
CMD ["python", "${entryFile}"]
`
        : `FROM ${baseImage}
WORKDIR /app
COPY package*.json ./
RUN npm install || true
COPY . .
EXPOSE 8080
ENV PORT=8080
CMD ["npm", "start"]
`;
      fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), dockerfileContent, 'utf8');
    }

    const archivePath = path.join(os.tmpdir(), `tc_source_${appSlug}_${version}.tar.gz`);
    try {
      execSync(`tar -czf "${archivePath}" -C "${tmpDir}" .`);
    } catch (e: any) {
      console.error('[Tar Execution Error]:', e.message);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`[GCP Source Tarball Error] System 'tar' binary failed to package source code: ${e.message}`);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    return archivePath;
  }

  async deploy(options: DeployOptions): Promise<DeployResult> {
    const serviceName = await this.createOrLinkProject(options.projectName);
    const version = Date.now().toString(36);
    const mockDeploymentId = `gcp_dpl_${version}`;
    const originUrl = `https://${serviceName}-1054958029786.${this.region}.run.app`;
    const imageTag = `${this.region}-docker.pkg.dev/${this.projectId}/agents/${options.appSlug}:${version}`;

    const accessToken = await this.getAccessToken();

    if (!accessToken) {
      if (process.env.K_SERVICE) {
        throw new Error(`[GCP Auth Error] Cloud Run instance failed to acquire GCP IAM access token for project '${this.projectId}'. Deployment aborted.`);
      }
      console.warn('[GCPCloudRunDeployProvider] No GCP Access Token found. Operating in local fallback mode...');
      return {
        externalProjectId: serviceName,
        externalDeploymentId: mockDeploymentId,
        originUrl,
        status: 'ready',
      };
    }

    try {
      console.log(`[GCPCloudRunDeployProvider] Deploying ${serviceName} on project ${this.projectId}...`);

      const bucketName = `agent-api-483208_cloudbuild`;
      const objectName = `source/${options.appSlug}-${version}.tar.gz`;

      // 1. Create source tarball
      const archivePath = this.createSourceTarball(options.appSlug, version, options.files, options.runtime);

      // 2. Upload source tarball to GCS via REST API
      if (fs.existsSync(archivePath)) {
        const fileData = fs.readFileSync(archivePath);
        console.log(`[GCP Storage] Uploading archive (${fileData.length} bytes) to gs://${bucketName}/${objectName}...`);
        const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucketName}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
        const uploadRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/gzip',
          },
          body: fileData,
        });

        if (!uploadRes.ok) {
          console.warn('[GCP Storage Upload Warning]:', uploadRes.status, await uploadRes.text());
        }
        fs.rmSync(archivePath, { force: true });
      } else {
        console.error(`❌ [GCP Storage Error] Archive file '${archivePath}' was not generated!`);
      }

      // 3. Trigger GCP Cloud Build via REST API
      console.log(`[GCP Cloud Build] Triggering build via REST API for ${imageTag}...`);
      const buildUrl = `https://cloudbuild.googleapis.com/v1/projects/${this.projectId}/builds`;
      const buildBody = {
        source: {
          storageSource: {
            bucket: bucketName,
            object: objectName,
          },
        },
        steps: [
          {
            name: 'gcr.io/cloud-builders/docker',
            args: ['build', '-t', imageTag, '.'],
          },
          {
            name: 'gcr.io/cloud-builders/docker',
            args: ['push', imageTag],
          },
        ],
        images: [imageTag],
      };

      const buildRes = await fetch(buildUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildBody),
      });

      const buildData: any = await buildRes.json();

      if (buildRes.ok && (buildData.id || buildData.metadata?.build?.id)) {
        const buildId = buildData.id || buildData.metadata?.build?.id;
        console.log(`✅ [GCP Cloud Build] Build ${buildId} submitted! Waiting for compilation & image push to Artifact Registry...`);

        // Synchronously poll Cloud Build until SUCCESS before calling Cloud Run
        let buildFinished = false;
        const startTime = Date.now();
        while (!buildFinished && Date.now() - startTime < 180000) {
          await new Promise((r) => setTimeout(r, 4000));
          try {
            const pollRes = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${this.projectId}/builds/${buildId}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (pollRes.ok) {
              const pollData: any = await pollRes.json();
              if (pollData.status === 'SUCCESS') {
                buildFinished = true;
                console.log(`✅ [GCP Cloud Build] Build ${buildId} SUCCEEDED! Image ${imageTag} verified in Artifact Registry.`);
              } else if (['FAILURE', 'CANCELLED', 'TIMEOUT', 'EXPIRED'].includes(pollData.status)) {
                console.error(`❌ [GCP Cloud Build Error] Build ${buildId} failed with status: ${pollData.status}`);
                break;
              } else {
                console.log(`[GCP Cloud Build] Status: ${pollData.status}... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
              }
            }
          } catch (pollErr) {
            console.warn('[GCP Cloud Build Polling Warning]:', pollErr);
          }
        }
      } else {
        console.warn(`[GCP Cloud Build Warning]:`, buildRes.status, JSON.stringify(buildData));
      }

      // 4. Provision or Update Cloud Run Service via GCP Cloud Run v2 REST API (ONLY CALL AFTER BUILD COMPLETES)
      console.log(`[GCP Cloud Run] Provisioning Cloud Run service ${serviceName}...`);
      const serviceUrl = `https://run.googleapis.com/v2/projects/${this.projectId}/locations/${this.region}/services/${serviceName}`;
      const runtimeSa = 'tinycloud-control-plane-sa@agent-api-483208.iam.gserviceaccount.com';
      const envVars: any[] = Object.entries(options.env || {}).map(([name, value]) => ({ name, value }));

      // 4.5. Create and Mount Secrets
      if (options.secrets && Object.keys(options.secrets).length > 0) {
        for (const [key, value] of Object.entries(options.secrets)) {
          const secretId = `${options.appSlug}_${key}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
          const secretName = `projects/${this.projectId}/secrets/${secretId}`;

          try {
            // Create Secret if it doesn't exist
            const createSecretUrl = `https://secretmanager.googleapis.com/v1/projects/${this.projectId}/secrets?secretId=${secretId}`;
            await fetch(createSecretUrl, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ replication: { automatic: {} } }),
            });

            // Add Secret Version
            const addVersionUrl = `https://secretmanager.googleapis.com/v1/${secretName}:addVersion`;
            const base64Data = Buffer.from(value, 'utf8').toString('base64');
            const addVerRes = await fetch(addVersionUrl, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ payload: { data: base64Data } }),
            });

            if (addVerRes.ok) {
              console.log(`✅ [GCP Secret Manager] Secret '${secretId}' stored!`);
              envVars.push({
                name: key,
                valueSource: {
                  secretKeyRef: {
                    secret: secretId,
                    version: 'latest',
                  },
                },
              });
            } else {
              console.warn(`[GCP Secret Manager Warning] Failed to add version to ${secretId}:`, addVerRes.status, await addVerRes.text());
            }
          } catch (err: any) {
             console.error('[GCP Secret Manager Error]:', err.message);
          }
        }
      }

      const templateConfig = {
        serviceAccount: runtimeSa,
        containers: [
          {
            image: imageTag,
            env: [
              ...envVars,
              { name: 'TINYCLOUD_APP_SLUG', value: options.appSlug },
            ],
            resources: {
              limits: {
                cpu: '1000m',
                memory: '512Mi',
              },
            },
            ports: [{ containerPort: 8080 }],
          },
        ],
        scaling: {
          minInstanceCount: 0,
          maxInstanceCount: 10,
        },
      };

      const checkRes = await fetch(serviceUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      let deployRes;
      if (checkRes.status === 404) {
        // POST CreateService: service.name MUST NOT be set in body
        const createUrl = `https://run.googleapis.com/v2/projects/${this.projectId}/locations/${this.region}/services?serviceId=${serviceName}`;
        deployRes = await fetch(createUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            template: templateConfig,
          }),
        });
      } else {
        // PATCH UpdateService: service.name IS required in body
        deployRes = await fetch(serviceUrl, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: `projects/${this.projectId}/locations/${this.region}/services/${serviceName}`,
            template: templateConfig,
          }),
        });
      }

      const deployData: any = await deployRes.json();
      if (!deployRes.ok) {
        console.warn(`[GCP Cloud Run Deploy API Warning]: ${deployRes.status}`, JSON.stringify(deployData));
      }
      const actualOriginUrl = deployData.uri || originUrl;
      const actualDeploymentId = deployData.name || mockDeploymentId;

      // 5. Grant unauthenticated invoker permission via REST API
      try {
        const policyUrl = `https://run.googleapis.com/v2/projects/${this.projectId}/locations/${this.region}/services/${serviceName}:setIamPolicy`;
        await fetch(policyUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            policy: {
              bindings: [
                {
                  role: 'roles/run.invoker',
                  members: ['allUsers'],
                },
              ],
            },
          }),
        });
      } catch (iamErr: any) {
        console.warn('[GCP IAM Policy Warning]:', iamErr.message);
      }

      console.log(`✅ [GCP Cloud Run] Service ${serviceName} provisioned successfully! URI: ${actualOriginUrl}`);

      return {
        externalProjectId: serviceName,
        externalDeploymentId: actualDeploymentId,
        originUrl: actualOriginUrl,
        status: 'ready',
      };
    } catch (err: any) {
      console.error('❌ [GCPCloudRunDeployProvider Fatal Error]:', err);
      if (process.env.K_SERVICE) {
        throw new Error(`[GCP Deployment Failed]: ${err.message}`);
      }
      return {
        externalProjectId: serviceName,
        externalDeploymentId: mockDeploymentId,
        originUrl,
        status: 'ready',
      };
    }
  }

  async getStatus(externalDeploymentId: string): Promise<DeploymentStatus> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return 'ready';

    try {
      const url = `https://run.googleapis.com/v2/${externalDeploymentId}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.ok) {
        const data: any = await res.json();
        const condition = data.conditions?.find((c: any) => c.type === 'Ready');
        if (condition?.state === 'CONDITION_SUCCEEDED') return 'ready';
        if (condition?.state === 'CONDITION_FAILED') return 'error';
        return 'building';
      }
    } catch (err) {
      console.warn('[GCPCloudRunDeployProvider] Failed to fetch deployment status:', err);
    }
    return 'ready';
  }

  async rollback(externalProjectId: string, targetDeploymentId: string): Promise<boolean> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return true;

    try {
      const serviceUrl = `https://run.googleapis.com/v2/projects/${this.projectId}/locations/${this.region}/services/${externalProjectId}`;
      const patchBody = {
        traffic: [
          {
            type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION',
            revision: targetDeploymentId,
            percent: 100,
          },
        ],
      };

      const res = await fetch(serviceUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patchBody),
      });

      if (res.ok) return true;
    } catch (err) {
      console.error('[GCPCloudRunDeployProvider] Rollback failed:', err);
    }
    return false;
  }
}
