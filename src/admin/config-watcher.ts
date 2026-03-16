// @premium — BlueOnion internal only.
import * as k8s from '@kubernetes/client-node';
import { logger } from '../utils/logger';

export interface AdminUser {
  platform: string;    // 'telegram' | 'slack' | 'teams'
  userId: string;
  displayName: string;
}

const CONFIGMAP_NAME = 'blue-y-admin-users';
const POLL_INTERVAL_MS = 30_000;

let adminUsers: AdminUser[] = [];
let poller: NodeJS.Timeout | null = null;
let coreApi: k8s.CoreV1Api | null = null;
let watchNamespace = 'prod';

function parseAdminUsers(data: Record<string, string>): AdminUser[] {
  const users: AdminUser[] = [];
  for (const value of Object.values(data)) {
    // Format: "platform:userId:Display Name"
    // e.g.   "telegram:123456789:Zeeshan Ali"
    const parts = value.trim().split(':');
    if (parts.length >= 3) {
      users.push({
        platform: parts[0],
        userId: parts[1],
        displayName: parts.slice(2).join(':'),
      });
    } else {
      logger.warn(`[admin] Skipping malformed admin user entry: "${value}" — expected "platform:userId:Name"`);
    }
  }
  return users;
}

async function fetchAdminUsers(): Promise<void> {
  if (!coreApi) return;
  try {
    const res = await coreApi.readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: watchNamespace });
    const parsed = parseAdminUsers(res.data ?? {});
    if (JSON.stringify(parsed) !== JSON.stringify(adminUsers)) {
      adminUsers = parsed;
      logger.info(`[admin] ConfigMap updated: ${adminUsers.length} admin user(s) loaded`);
    }
  } catch (e: any) {
    if (e?.response?.statusCode === 404) {
      logger.warn(`[admin] ConfigMap "${CONFIGMAP_NAME}" not found in namespace "${watchNamespace}" — admin whitelist empty`);
      adminUsers = [];
    } else {
      logger.warn('[admin] Failed to read admin ConfigMap', e?.message);
    }
  }
}

export async function startConfigWatcher(namespace: string): Promise<void> {
  watchNamespace = namespace;
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  coreApi = kc.makeApiClient(k8s.CoreV1Api);

  await fetchAdminUsers(); // load immediately on start
  poller = setInterval(fetchAdminUsers, POLL_INTERVAL_MS);
  logger.info(`[admin] ConfigMap watcher started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
}

export function stopConfigWatcher(): void {
  if (poller) { clearInterval(poller); poller = null; }
}

export function isAdminUser(platform: string, userId: string): AdminUser | undefined {
  return adminUsers.find((u) => u.platform === platform && u.userId === String(userId));
}

export function getAdminUsers(): AdminUser[] {
  return [...adminUsers];
}

/** Add or overwrite an admin user entry in the ConfigMap. Key = platform_userId. */
export async function addAdminUser(user: AdminUser): Promise<void> {
  if (!coreApi) throw new Error('Config watcher not started');
  const key = `${user.platform}_${user.userId}`;
  const value = `${user.platform}:${user.userId}:${user.displayName}`;

  // Fetch current ConfigMap data
  let currentData: Record<string, string> = {};
  try {
    const res = await coreApi.readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: watchNamespace });
    currentData = res.data ?? {};
  } catch (e: any) {
    if (e?.response?.statusCode !== 404) throw e;
    // ConfigMap doesn't exist — create it
    await coreApi.createNamespacedConfigMap({
      namespace: watchNamespace,
      body: { metadata: { name: CONFIGMAP_NAME }, data: { [key]: value } },
    });
    adminUsers = [...adminUsers.filter(u => !(u.platform === user.platform && u.userId === user.userId)), user];
    logger.info(`[admin] ConfigMap created with first admin user: ${user.platform}:${user.userId}`);
    return;
  }

  currentData[key] = value;
  await coreApi.replaceNamespacedConfigMap({
    name: CONFIGMAP_NAME,
    namespace: watchNamespace,
    body: { metadata: { name: CONFIGMAP_NAME }, data: currentData },
  });
  adminUsers = [...adminUsers.filter(u => !(u.platform === user.platform && u.userId === user.userId)), user];
  logger.info(`[admin] Admin user added/updated: ${user.platform}:${user.userId} (${user.displayName})`);
}

/** Remove an admin user entry from the ConfigMap. */
export async function removeAdminUser(platform: string, userId: string): Promise<boolean> {
  if (!coreApi) throw new Error('Config watcher not started');
  const key = `${platform}_${userId}`;

  const res = await coreApi.readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: watchNamespace });
  const currentData = res.data ?? {};
  if (!(key in currentData)) return false;

  delete currentData[key];
  await coreApi.replaceNamespacedConfigMap({
    name: CONFIGMAP_NAME,
    namespace: watchNamespace,
    body: { metadata: { name: CONFIGMAP_NAME }, data: currentData },
  });
  adminUsers = adminUsers.filter(u => !(u.platform === platform && u.userId === userId));
  logger.info(`[admin] Admin user removed: ${platform}:${userId}`);
  return true;
}
