import { DeploymentStatus } from '../types/domain.js';

export interface DeployOptions {
  appSlug: string;
  projectName: string;
  files: Record<string, string>; // filename -> file content
  env?: Record<string, string>;
  secrets?: Record<string, string>; // direct secret mapping
  runtime?: string; // e.g. python311, python314, node20, node24
}

export interface DeployResult {
  externalProjectId: string;
  externalDeploymentId: string;
  originUrl: string; // e.g. https://xyz.vercel.app
  status: DeploymentStatus;
}

export interface DeployProvider {
  name: string;
  createOrLinkProject(projectName: string): Promise<string>; // returns externalProjectId
  deploy(options: DeployOptions): Promise<DeployResult>;
  getStatus(externalDeploymentId: string): Promise<DeploymentStatus>;
  rollback(externalProjectId: string, targetDeploymentId: string): Promise<boolean>;
}
