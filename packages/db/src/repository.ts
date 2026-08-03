import { db, sql, memoryStore } from './client.js';
import * as schema from './schema/index.js';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

export class DbRepository {
  private initialized = false;

  public async initDb(): Promise<void> {
    if (this.initialized || !process.env.DATABASE_URL) return;
    try {
      // Execute CREATE TABLE IF NOT EXISTS for all core tables
      await sql`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          domain TEXT,
          api_key TEXT,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          org_id TEXT NOT NULL,
          role TEXT DEFAULT 'member' NOT NULL,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS apps (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          owner_id TEXT NOT NULL,
          external_ref TEXT,
          current_deployment_id TEXT,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS share_policies (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL UNIQUE,
          org_id TEXT NOT NULL,
          visibility TEXT DEFAULT 'org' NOT NULL,
          allowed_emails JSONB DEFAULT '[]'::jsonb NOT NULL,
          allowed_domains JSONB DEFAULT '[]'::jsonb NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deployments (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          artifact_hash TEXT NOT NULL,
          status TEXT DEFAULT 'queued' NOT NULL,
          share_url TEXT NOT NULL,
          origin_url TEXT,
          external_deployment_id TEXT,
          created_by TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          key_prefix TEXT NOT NULL,
          scopes JSONB DEFAULT '[]'::jsonb NOT NULL,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          last_used_at TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS secrets (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          environment TEXT DEFAULT 'production' NOT NULL,
          key TEXT NOT NULL,
          encrypted_value TEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS access_requests (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          requester_email TEXT NOT NULL,
          reason TEXT,
          status TEXT DEFAULT 'pending' NOT NULL,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          app_id TEXT,
          actor_id TEXT NOT NULL,
          actor_type TEXT DEFAULT 'user' NOT NULL,
          action TEXT NOT NULL,
          metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
          timestamp TIMESTAMP DEFAULT NOW() NOT NULL
        );
      `;

      // Seed default org if empty
      const defaultOrgId = 'org_acme';
      const existingOrg = await db.select().from(schema.organizations).where(eq(schema.organizations.id, defaultOrgId));
      if (existingOrg.length === 0) {
        await db.insert(schema.organizations).values({
          id: defaultOrgId,
          name: 'Acme Corp',
          slug: 'acme',
          domain: 'acme.com',
          apiKey: 'tc_live_055ac4ce735958519216c0771a874c78532a6f868e51f49d30008099605242c4',
        });
      }

      // Seed default API key if empty
      const rawSeedKey = 'tc_live_055ac4ce735958519216c0771a874c78532a6f868e51f49d30008099605242c4';
      const seedHash = crypto.createHash('sha256').update(rawSeedKey).digest('hex');
      const existingKey = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyHash, seedHash));
      if (existingKey.length === 0) {
        await db.insert(schema.apiKeys).values({
          id: 'key_acme_live',
          orgId: defaultOrgId,
          name: 'Acme Production Key',
          keyHash: seedHash,
          keyPrefix: 'tc_live_055ac4ce...',
          scopes: ['apps:read', 'apps:write', 'secrets:write'],
        });
      }

      this.initialized = true;
      console.log('[DbRepository] PostgreSQL schema verified & initialized successfully!');
    } catch (err) {
      console.error('[DbRepository] Failed to initialize PostgreSQL tables:', (err as any).message);
    }
  }

  // --- API KEY METHODS ---
  public async validateApiKey(rawKey: string): Promise<{ orgId: string; scopes: string[] } | null> {
    if (!rawKey) return null;
    if (process.env.DATABASE_URL) {
      try {
        await this.initDb();
        const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const keys = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyHash, hash));
        if (keys.length > 0) {
          const keyRecord = keys[0];
          db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, keyRecord.id)).then(() => {}).catch(() => {});
          return { orgId: keyRecord.orgId, scopes: (keyRecord.scopes as string[]) || ['*'] };
        }
      } catch (e) {
        console.warn('[DbRepository] PostgreSQL validateApiKey failed, using MemoryStore fallback');
      }
    }
    return memoryStore.validateApiKey(rawKey);
  }

  public async createApiKey(orgId: string, name: string, scopes?: string[]): Promise<{ keyRecord: any; secretToken: string }> {
    const rawKey = `tc_live_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyId = `key_${Date.now().toString(36)}`;

    const keyRecord = {
      id: keyId,
      orgId,
      name: name || 'API Key',
      keyHash,
      keyPrefix: `${rawKey.substring(0, 16)}...`,
      scopes: scopes || ['apps:read', 'apps:write', 'secrets:write'],
      createdAt: new Date(),
    };

    memoryStore.apiKeys.set(keyId, keyRecord);

    if (process.env.DATABASE_URL) {
      try {
        await this.initDb();
        await db.insert(schema.apiKeys).values(keyRecord);
      } catch (e) {
        console.warn('[DbRepository] PostgreSQL createApiKey failed, saved to MemoryStore');
      }
    }
    return { keyRecord, secretToken: rawKey };
  }

  public async listApiKeys(orgId: string): Promise<any[]> {
    if (process.env.DATABASE_URL) {
      try {
        await this.initDb();
        return await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.orgId, orgId));
      } catch (e) {
        console.warn('[DbRepository] PostgreSQL listApiKeys failed, using MemoryStore fallback');
      }
    }
    return Array.from(memoryStore.apiKeys.values()).filter(k => k.orgId === orgId);
  }

  public async revokeApiKey(keyId: string): Promise<void> {
    memoryStore.apiKeys.delete(keyId);
    if (process.env.DATABASE_URL) {
      try {
        await this.initDb();
        await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, keyId));
      } catch (e) {
        console.warn('[DbRepository] PostgreSQL revokeApiKey failed');
      }
    }
  }

  // --- APP & DEPLOYMENT METHODS ---
  public async getAppsByOrg(orgId: string): Promise<any[]> {
    if (process.env.DATABASE_URL) {
      try {
        await this.initDb();
        const appRecords = await db.select().from(schema.apps).where(eq(schema.apps.orgId, orgId));
        const result: any[] = [];
        for (const app of appRecords) {
          const fullApp = await this.getAppById(app.id);
          if (fullApp) result.push(fullApp);
        }
        if (result.length > 0) return result;
      } catch (e) {
        console.warn('[DbRepository] PostgreSQL getAppsByOrg failed, using MemoryStore fallback');
      }
    }
    return Array.from(memoryStore.apps.values())
      .filter(a => a.orgId === orgId)
      .map(app => ({
        ...app,
        shareUrl: `https://${app.slug}.cloudery.xyz`,
        visibility: memoryStore.sharePolicies.get(app.id)?.visibility || 'org',
        status: memoryStore.deployments.get(app.currentDeploymentId)?.status || 'ready',
      }));
  }

  public async getAppById(appId: string): Promise<any | null> {
    if (process.env.DATABASE_URL) {
      try {
        await this.initDb();
        const records = await db.select().from(schema.apps).where(eq(schema.apps.id, appId));
        if (records.length > 0) {
          const app = records[0];
          const currentDeployment = app.currentDeploymentId
            ? (await db.select().from(schema.deployments).where(eq(schema.deployments.id, app.currentDeploymentId)))[0]
            : null;
          const sharePolicy = (await db.select().from(schema.sharePolicies).where(eq(schema.sharePolicies.appId, app.id)))[0];
          return {
            ...app,
            shareUrl: currentDeployment?.shareUrl || `https://${app.slug}.cloudery.xyz`,
            originUrl: currentDeployment?.originUrl || (app.externalRef ? `https://${app.externalRef}-1054958029786.us-central1.run.app` : null),
            visibility: sharePolicy?.visibility || 'org',
            status: currentDeployment?.status || 'ready',
          };
        }
      } catch (e) {
        console.warn('[DbRepository] PostgreSQL getAppById failed, using MemoryStore fallback');
      }
    }
    const memApp = memoryStore.apps.get(appId);
    if (!memApp) return null;
    return {
      ...memApp,
      shareUrl: `https://${memApp.slug}.cloudery.xyz`,
      originUrl: memApp.originUrl || (memApp.externalRef ? `https://${memApp.externalRef}-1054958029786.us-central1.run.app` : null),
      visibility: memoryStore.sharePolicies.get(memApp.id)?.visibility || 'org',
      status: memoryStore.deployments.get(memApp.currentDeploymentId)?.status || 'ready',
    };
  }

  public async getAppBySlug(slug: string): Promise<any | null> {
    if (process.env.DATABASE_URL) {
      try {
        await this.initDb();
        const records = await db.select().from(schema.apps).where(eq(schema.apps.slug, slug));
        if (records.length > 0) {
          return this.getAppById(records[0].id);
        }
      } catch (e) {
        console.warn('[DbRepository] PostgreSQL getAppBySlug failed, using MemoryStore fallback');
      }
    }
    const memApp = Array.from(memoryStore.apps.values()).find(a => a.slug === slug);
    if (!memApp) return null;
    return this.getAppById(memApp.id);
  }

  public async saveAppAndDeployment(appData: any, deploymentData: any, sharePolicyData: any): Promise<void> {
    memoryStore.apps.set(appData.id, appData);
    if (deploymentData) memoryStore.deployments.set(deploymentData.id, deploymentData);
    if (sharePolicyData) memoryStore.sharePolicies.set(appData.id, sharePolicyData);

    if (process.env.DATABASE_URL) {
      try {
        await this.initDb();
        const existingApp = await db.select().from(schema.apps).where(eq(schema.apps.id, appData.id));
        if (existingApp.length === 0) {
          await db.insert(schema.apps).values(appData);
        } else {
          await db.update(schema.apps).set(appData).where(eq(schema.apps.id, appData.id));
        }

        if (deploymentData) {
          await db.insert(schema.deployments).values(deploymentData);
        }

        if (sharePolicyData) {
          const existingPolicy = await db.select().from(schema.sharePolicies).where(eq(schema.sharePolicies.appId, appData.id));
          if (existingPolicy.length === 0) {
            await db.insert(schema.sharePolicies).values(sharePolicyData);
          } else {
            await db.update(schema.sharePolicies).set(sharePolicyData).where(eq(schema.sharePolicies.appId, appData.id));
          }
        }
      } catch (e) {
        console.warn('[DbRepository] PostgreSQL saveAppAndDeployment failed, saved to MemoryStore');
      }
    }
  }

  public async getSharePolicy(appId: string): Promise<any | null> {
    if (process.env.DATABASE_URL) {
      try {
        await this.initDb();
        const policies = await db.select().from(schema.sharePolicies).where(eq(schema.sharePolicies.appId, appId));
        if (policies.length > 0) return policies[0];
      } catch (e) {
        console.warn('[DbRepository] PostgreSQL getSharePolicy failed, using MemoryStore fallback');
      }
    }
    return memoryStore.sharePolicies.get(appId) || null;
  }
}

export const dbRepository = new DbRepository();
