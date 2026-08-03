import { pgTable, text, timestamp, jsonb, primaryKey } from 'drizzle-orm/pg-core';

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  domain: text('domain'),
  apiKey: text('api_key'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  orgId: text('org_id').references(() => organizations.id).notNull(),
  role: text('role').notNull().default('member'), // owner | admin | member
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const apps = pgTable('apps', {
  id: text('id').primaryKey(),
  orgId: text('org_id').references(() => organizations.id).notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  ownerId: text('owner_id').references(() => users.id).notNull(),
  externalRef: text('external_ref'), // Vercel Project ID / GCP Service
  currentDeploymentId: text('current_deployment_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const sharePolicies = pgTable('share_policies', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => apps.id).notNull().unique(),
  orgId: text('org_id').references(() => organizations.id).notNull(),
  visibility: text('visibility').notNull().default('org'), // private | org | link
  allowedEmails: jsonb('allowed_emails').$type<string[]>().default([]).notNull(),
  allowedDomains: jsonb('allowed_domains').$type<string[]>().default([]).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const deployments = pgTable('deployments', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => apps.id).notNull(),
  orgId: text('org_id').references(() => organizations.id).notNull(),
  artifactHash: text('artifact_hash').notNull(),
  status: text('status').notNull().default('queued'), // queued | building | ready | error
  shareUrl: text('share_url').notNull(),
  originUrl: text('origin_url'),
  externalDeploymentId: text('external_deployment_id'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const auditEvents = pgTable('audit_events', {
  id: text('id').primaryKey(),
  orgId: text('org_id').references(() => organizations.id).notNull(),
  appId: text('app_id').references(() => apps.id),
  actorId: text('actor_id').notNull(),
  actorType: text('actor_type').notNull().default('user'), // user | agent
  action: text('action').notNull(),
  metadata: jsonb('metadata').$type<Record<string, any>>().default({}).notNull(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
});

export const secrets = pgTable('secrets', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => apps.id).notNull(),
  orgId: text('org_id').references(() => organizations.id).notNull(),
  environment: text('environment').notNull().default('production'), // production | staging | development
  key: text('key').notNull(),
  encryptedValue: text('encrypted_value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const accessRequests = pgTable('access_requests', {
  id: text('id').primaryKey(),
  appId: text('app_id').references(() => apps.id).notNull(),
  orgId: text('org_id').references(() => organizations.id).notNull(),
  requesterEmail: text('requester_email').notNull(),
  reason: text('reason'),
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const apiKeys = pgTable('api_keys', {
  id: text('id').primaryKey(),
  orgId: text('org_id').references(() => organizations.id).notNull(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  scopes: jsonb('scopes').$type<string[]>().default([]).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at'),
});
