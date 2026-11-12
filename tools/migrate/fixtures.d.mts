export function encv2(keyHex: string, owner: string, id: string, value: string): Promise<string>;
export function encv1(keyHex: string, value: string): Promise<string>;
export function generateGonvexExport(options?: { key?: string; now?: number }): Promise<{
  exportDoc: { format: string; exported_at: string; tables: Record<string, Array<Record<string, any>>> };
  key: string;
  secrets: Record<string, string>;
  apiKeys: Record<string, string>;
  sessions: Record<string, string>;
}>;
