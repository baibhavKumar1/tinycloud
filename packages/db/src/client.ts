import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/tinycloud';

export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql, { schema });

// In-memory fallback repository for quick local development / dev mode without DB
export class MemoryStore {
  public orgs = new Map<string, any>();
  public users = new Map<string, any>();
  public apps = new Map<string, any>();
  public sharePolicies = new Map<string, any>();
  public deployments = new Map<string, any>();
  public secrets = new Map<string, any>(); // key: `${appId}:${environment}:${secretKey}`
  public accessRequests = new Map<string, any>();
  public auditEvents: any[] = [];

  constructor() {
    // Seed default demo tenants
    const acmeOrg = {
      id: 'org_acme',
      name: 'Acme Corp',
      slug: 'acme',
      domain: 'acme.com',
      apiKey: 'tc_key_acme_live_123',
      createdAt: new Date(),
    };
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
}

export const memoryStore = new MemoryStore();
