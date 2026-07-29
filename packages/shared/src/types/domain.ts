export interface Organization {
  id: string;
  name: string;
  slug: string;
  domain?: string; // e.g. acme.com
  apiKey?: string;
  createdAt: Date;
}

export interface User {
  id: string;
  email: string;
  name: string;
  orgId: string;
  role: 'owner' | 'admin' | 'member';
  createdAt: Date;
}

export interface App {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description?: string;
  ownerId: string;
  externalRef?: string; // e.g. Vercel project ID / GCP service name
  currentDeploymentId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type VisibilityMode = 'private' | 'org' | 'link';

export interface SharePolicy {
  id: string;
  appId: string;
  orgId: string;
  visibility: VisibilityMode;
  allowedEmails: string[];
  allowedDomains: string[];
  updatedAt: Date;
}

export type DeploymentStatus = 'queued' | 'building' | 'ready' | 'error' | 'cancelled';

export interface Deployment {
  id: string;
  appId: string;
  orgId: string;
  artifactHash: string;
  status: DeploymentStatus;
  shareUrl: string;
  originUrl?: string; // Direct Vercel / GCP / AWS origin deployment URL
  externalDeploymentId?: string;
  createdBy: string; // user or agent identity
  createdAt: Date;
}

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected';

export interface AccessRequest {
  id: string;
  appId: string;
  orgId: string;
  requesterEmail: string;
  reason?: string;
  status: AccessRequestStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditEvent {
  id: string;
  orgId: string;
  appId?: string;
  actorId: string;
  actorType: 'user' | 'agent';
  action: 'deploy' | 'share_policy_change' | 'rollback' | 'access_granted' | 'access_denied' | 'app_created' | 'secret_updated' | 'access_requested' | 'access_approved' | 'access_rejected';
  metadata: Record<string, any>;
  timestamp: Date;
}

export interface Secret {
  id: string;
  appId: string;
  orgId: string;
  environment: 'production' | 'staging' | 'development';
  key: string;
  encryptedValue: string;
  updatedAt: Date;
}
