// Types for the JavaScript backup tooling, used by the TypeScript test suite.
export interface BackupDatabase {
  binding: string;
  label: string;
  databaseId: string;
  config: string;
  localConfig: string;
  minimumBytes: number;
}
export const DATABASES: BackupDatabase[];
