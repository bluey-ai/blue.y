// @premium — BlueOnion internal only. (BLY-63)
// WebSocket handler for pod exec — allows admins to open a terminal into any running pod.
import * as http from 'http';
import { PassThrough } from 'stream';
import * as WebSocket from 'ws';
import * as k8s from '@kubernetes/client-node';
import { validateSession } from './auth';
import { logger } from '../utils/logger';

const ROLE_RANK: Record<string, number> = { superadmin: 3, admin: 2, viewer: 1 };

// Parse cookie header into key→value map (avoid dependency on `cookie` package)
function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    (header || '').split(';').map(p => {
      const i = p.indexOf('=');
      if (i < 0) return ['', ''];
      return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
    }).filter(([k]) => k),
  );
}

export function setupExecWebSocket(server: http.Server): void {
  const wss = new WebSocket.WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const pathname = req.url?.split('?')[0] ?? '';
    if (pathname !== '/admin/ws/exec') {
      socket.destroy();
      return;
    }

    // Validate session from cookie — require admin or superadmin
    const cookies = parseCookies(req.headers.cookie ?? '');
    const session = validateSession(cookies['bluey_admin_session']);
    if (!session || (ROLE_RANK[session.role] ?? 0) < 2) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const namespace = url.searchParams.get('namespace') || 'default';
      const pod       = url.searchParams.get('pod') || '';
      const container = url.searchParams.get('container') || '';

      if (!pod) {
        ws.close(4000, 'pod parameter is required');
        return;
      }

      logger.info(`[exec] ${session.name} (${session.role}) opened terminal: ${namespace}/${pod}${container ? `/${container}` : ''}`);
      handleExecSession(ws, namespace, pod, container, session.name);
    });
  });
}

async function handleExecSession(
  ws: WebSocket.WebSocket,
  namespace: string,
  pod: string,
  container: string,
  user: string,
): Promise<void> {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const exec = new k8s.Exec(kc);

  const stdin  = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const send = (type: string, data: string) => {
    if (ws.readyState === WebSocket.WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  };

  stdout.on('data', (chunk: Buffer) => send('output', chunk.toString('utf8')));
  stderr.on('data', (chunk: Buffer) => send('output', chunk.toString('utf8')));

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        stdin.write(msg.data);
      }
      // resize: xterm sends this but k8s Exec doesn't support live resize via streams
    } catch { /* ignore malformed */ }
  });

  ws.on('close', () => {
    stdin.end();
    logger.info(`[exec] Terminal closed: ${namespace}/${pod} (${user})`);
  });

  ws.on('error', () => stdin.end());

  try {
    await exec.exec(
      namespace,
      pod,
      container,
      // Try bash first, fall back to sh
      ['/bin/sh', '-c', 'TERM=xterm-256color; export TERM; [ -x /bin/bash ] && exec /bin/bash || exec /bin/sh'],
      stdout,
      stderr,
      stdin,
      true, // tty=true for interactive shell
      (status: k8s.V1Status) => {
        if (status.status === 'Failure') {
          send('error', status.message ?? 'Shell exited with failure');
        }
        ws.close();
      },
    );
  } catch (e: any) {
    logger.error(`[exec] kubectl exec failed: ${namespace}/${pod} — ${e?.message}`);
    send('error', `Failed to open shell: ${e?.message ?? String(e)}`);
    ws.close();
  }
}
