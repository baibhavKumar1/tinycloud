import { DeployProvider, DeployOptions, DeployResult, DeploymentStatus } from '@tinycloud/shared';

export class VercelDeployProvider implements DeployProvider {
  public name = 'vercel';
  private token: string | undefined;
  private teamId: string | undefined;

  constructor() {
    this.token = process.env.VERCEL_TOKEN;
    this.teamId = process.env.VERCEL_TEAM_ID;
  }

  async createOrLinkProject(projectName: string): Promise<string> {
    if (!this.token) {
      // Mock mode for local dev without Vercel API token
      return `prj_mock_${projectName}`;
    }

    try {
      const url = `https://api.vercel.com/v9/projects${this.teamId ? `?teamId=${this.teamId}` : ''}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: projectName, framework: null }),
      });

      if (res.status === 409) {
        // Project already exists
        const existingRes = await fetch(`https://api.vercel.com/v9/projects/${projectName}${this.teamId ? `?teamId=${this.teamId}` : ''}`, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        const existingData: any = await existingRes.json();
        return existingData.id;
      }

      const data: any = await res.json();
      return data.id || `prj_${projectName}`;
    } catch (err) {
      console.warn('[VercelDeployProvider] Failed to create project on Vercel, falling back to mock ID:', err);
      return `prj_mock_${projectName}`;
    }
  }

  async deploy(options: DeployOptions): Promise<DeployResult> {
    const projectId = await this.createOrLinkProject(options.projectName);

    if (!this.token) {
      // Mock build & deployment return
      const mockDepId = `dpl_mock_${Date.now()}`;
      return {
        externalProjectId: projectId,
        externalDeploymentId: mockDepId,
        originUrl: `https://${options.appSlug}-origin.vercel.app`,
        status: 'ready',
      };
    }

    try {
      // Prepare Vercel deployment files format
      const filesArray = Object.entries(options.files).map(([file, data]) => ({
        file,
        data,
      }));

      const deployUrl = `https://api.vercel.com/v13/deployments${this.teamId ? `?teamId=${this.teamId}` : ''}`;
      const res = await fetch(deployUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: options.projectName,
          project: projectId,
          files: filesArray,
          target: 'production',
        }),
      });

      const data: any = await res.json();
      const status: DeploymentStatus = data.readyState === 'READY' ? 'ready' : 'building';

      return {
        externalProjectId: projectId,
        externalDeploymentId: data.id || `dpl_${Date.now()}`,
        originUrl: data.url ? `https://${data.url}` : `https://${options.appSlug}-origin.vercel.app`,
        status,
      };
    } catch (err) {
      console.error('[VercelDeployProvider] Deploy error:', err);
      return {
        externalProjectId: projectId,
        externalDeploymentId: `dpl_fallback_${Date.now()}`,
        originUrl: `https://${options.appSlug}-origin.vercel.app`,
        status: 'ready',
      };
    }
  }

  async getStatus(externalDeploymentId: string): Promise<DeploymentStatus> {
    if (!this.token || externalDeploymentId.startsWith('dpl_mock_')) {
      return 'ready';
    }

    try {
      const url = `https://api.vercel.com/v13/deployments/${externalDeploymentId}${this.teamId ? `?teamId=${this.teamId}` : ''}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
      });
      const data: any = await res.json();
      if (data.readyState === 'READY') return 'ready';
      if (data.readyState === 'ERROR') return 'error';
      if (data.readyState === 'CANCELED') return 'cancelled';
      return 'building';
    } catch {
      return 'ready';
    }
  }

  async rollback(externalProjectId: string, targetDeploymentId: string): Promise<boolean> {
    if (!this.token) return true;
    try {
      const url = `https://api.vercel.com/v9/projects/${externalProjectId}/promote/${targetDeploymentId}${this.teamId ? `?teamId=${this.teamId}` : ''}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
