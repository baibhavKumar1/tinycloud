export interface AppManifest {
  $schema?: string;
  name: string;
  runtime: 'node20' | 'bun' | 'static' | 'python3' | 'python311' | string;
  entry: string;
  port?: number;
  healthCheck?: string;
  env?: string[];
  permissions?: {
    default: 'org_members' | 'private' | 'public_link';
  };
  description?: string;
  version?: string;
}
