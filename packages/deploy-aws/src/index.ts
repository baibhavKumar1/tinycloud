import { DeployProvider, DeployOptions, DeployResult, DeploymentStatus } from '@cloudery/shared';

export class AWSAppRunnerDeployProvider implements DeployProvider {
  public name = 'aws-apprunner';
  private region: string;

  constructor() {
    this.region = process.env.AWS_REGION || 'us-east-1';
  }

  async createOrLinkProject(projectName: string): Promise<string> {
    const serviceName = `tc-${projectName.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    return serviceName;
  }

  async deploy(options: DeployOptions): Promise<DeployResult> {
    const serviceName = await this.createOrLinkProject(options.projectName);
    const mockDeploymentId = `aws_dpl_${Date.now().toString(36)}`;
    const originUrl = `https://${serviceName}.${this.region}.awsapprunner.com`;

    return {
      externalProjectId: serviceName,
      externalDeploymentId: mockDeploymentId,
      originUrl,
      status: 'ready',
    };
  }

  async getStatus(externalDeploymentId: string): Promise<DeploymentStatus> {
    return 'ready';
  }

  async rollback(externalProjectId: string, targetDeploymentId: string): Promise<boolean> {
    console.log(`[AWSAppRunnerDeployProvider] Rolling back ${externalProjectId} to target deployment ${targetDeploymentId}`);
    return true;
  }
}
