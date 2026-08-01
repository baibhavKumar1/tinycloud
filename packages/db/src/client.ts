import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/tinycloud';

export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql, { schema });

import crypto from 'crypto';

// In-memory fallback repository for quick local development / dev mode without DB
export class MemoryStore {
  public orgs = new Map<string, any>();
  public users = new Map<string, any>();
  public apps = new Map<string, any>();
  public sharePolicies = new Map<string, any>();
  public deployments = new Map<string, any>();
  public secrets = new Map<string, any>(); // key: `${appId}:${environment}:${secretKey}`
  public apiKeys = new Map<string, any>();
  public accessRequests = new Map<string, any>();
  public auditEvents: any[] = [];

  constructor() {
    // Seed default demo tenants
    const acmeOrg = {
      id: 'org_acme',
      name: 'Acme Corp',
      slug: 'acme',
      domain: 'acme.com',
      apiKey: 'tc_live_055ac4ce735958519216c0771a874c78532a6f868e51f49d30008099605242c4',
      createdAt: new Date(),
    };

    const acmeApiKey = {
      id: 'key_acme_live',
      orgId: 'org_acme',
      name: 'Acme Production Key',
      keyHash: crypto.createHash('sha256').update('tc_live_055ac4ce735958519216c0771a874c78532a6f868e51f49d30008099605242c4').digest('hex'),
      keyPrefix: 'tc_live_055ac4ce...',
      scopes: ['apps:read', 'apps:write', 'secrets:write'],
      createdAt: new Date(),
    };
    this.apiKeys.set(acmeApiKey.id, acmeApiKey);
    const globexOrg = {
      id: 'org_globex',
      name: 'Globex Corp',
      slug: 'globex',
      domain: 'globex.com',
      apiKey: 'tc_key_globex_live_456',
      createdAt: new Date(),
    };

    const acmeUser = {
      id: 'usr_demo',
      email: 'alex@acme.com',
      name: 'Alex Builder',
      orgId: acmeOrg.id,
      role: 'owner',
      createdAt: new Date(),
    };

    this.orgs.set(acmeOrg.id, acmeOrg);
    this.orgs.set(globexOrg.id, globexOrg);
    this.users.set(acmeUser.id, acmeUser);
  }

  public validateApiKey(rawKey: string): { orgId: string; scopes: string[] } | null {
    if (!rawKey) return null;
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    for (const keyObj of this.apiKeys.values()) {
      if (keyObj.keyHash === hash) {
        keyObj.lastUsedAt = new Date();
        return { orgId: keyObj.orgId, scopes: keyObj.scopes };
      }
    }
    for (const org of this.orgs.values()) {
      if (org.apiKey === rawKey || rawKey === 'tc_live_055ac4ce735958519216c0771a874c78532a6f868e51f49d30008099605242c4') {
        return { orgId: org.id, scopes: ['*'] };
      }
    }
    return null;
  }
}

export const memoryStore = new MemoryStore();
