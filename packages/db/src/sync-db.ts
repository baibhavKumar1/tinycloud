import postgres from 'postgres';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is not defined in .env');
  process.exit(1);
}

const sql = postgres(connectionString, { ssl: 'require', max: 1 });

async function sync() {
  console.log('[Neon PostgreSQL] Connecting to Neon DB...');
  try {
    // 1. Organizations
    await sql`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        domain TEXT,
        api_key TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `;

    // 2. Users
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        role TEXT DEFAULT 'member' NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `;

    // 3. Apps
    await sql`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        owner_id TEXT NOT NULL REFERENCES users(id),
        external_ref TEXT,
        current_deployment_id TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `;

    // 4. Share Policies
    await sql`
      CREATE TABLE IF NOT EXISTS share_policies (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL UNIQUE REFERENCES apps(id),
        org_id TEXT NOT NULL REFERENCES organizations(id),
        visibility TEXT DEFAULT 'org' NOT NULL,
        allowed_emails JSONB DEFAULT '[]'::jsonb NOT NULL,
        allowed_domains JSONB DEFAULT '[]'::jsonb NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `;

    // 5. Deployments
    await sql`
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES apps(id),
        org_id TEXT NOT NULL REFERENCES organizations(id),
        artifact_hash TEXT NOT NULL,
        status TEXT DEFAULT 'queued' NOT NULL,
        share_url TEXT NOT NULL,
        origin_url TEXT,
        external_deployment_id TEXT,
        created_by TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `;

    // 6. Audit Events
    await sql`
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        app_id TEXT REFERENCES apps(id),
        actor_id TEXT NOT NULL,
        actor_type TEXT DEFAULT 'user' NOT NULL,
        action TEXT NOT NULL,
        metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `;

    // 7. Secrets
    await sql`
      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES apps(id),
        org_id TEXT NOT NULL REFERENCES organizations(id),
        environment TEXT DEFAULT 'production' NOT NULL,
        key TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `;

    // 8. Access Requests
    await sql`
      CREATE TABLE IF NOT EXISTS access_requests (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES apps(id),
        org_id TEXT NOT NULL REFERENCES organizations(id),
        requester_email TEXT NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'pending' NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
      );
    `;

    // Seed default Acme & Globex organizations and default user if not existing
    await sql`
      INSERT INTO organizations (id, name, slug, domain, api_key)
      VALUES ('org_acme', 'Acme Corp', 'acme', 'acme.com', 'tc_key_acme_live_123')
      ON CONFLICT (id) DO NOTHING;
    `;

    await sql`
      INSERT INTO organizations (id, name, slug, domain, api_key)
      VALUES ('org_globex', 'Globex Corp', 'globex', 'globex.com', 'tc_key_globex_live_456')
      ON CONFLICT (id) DO NOTHING;
    `;

    await sql`
      INSERT INTO users (id, email, name, org_id, role)
      VALUES ('usr_demo', 'alex@acme.com', 'Alex Builder', 'org_acme', 'owner')
      ON CONFLICT (id) DO NOTHING;
    `;

    console.log('✅ Neon PostgreSQL database schema created and seeded successfully!');
  } catch (err) {
    console.error('❌ Neon PostgreSQL connection/migration error:', err);
  } finally {
    await sql.end();
  }
}

sync();
