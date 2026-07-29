export interface AppManifest {
  name: string;
  runtime: 'node20' | 'bun' | 'static' | 'python3';
  entry: string;
  env?: string[];
  permissions?: {
    default: 'org_members' | 'private' | 'public_link';
  };
  description?: string;
  version?: string;
}
