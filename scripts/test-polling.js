const { KubeClient } = require('../dist/clients/kube');
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
if (!BOT_TOKEN || !CHAT_ID) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars are required');
  process.exit(1);
}
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

let lastUpdateId = 0;
const kube = new KubeClient();

async function sendMsg(text) {
  await axios.post(`${API}/sendMessage`, {
    chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true,
  });
}

async function handleMessage(text) {
  const cmd = text.toLowerCase().trim();

  if (cmd === '/status' || cmd === 'status') {
    const namespaces = ['prod', 'doris', 'monitoring', 'wordpress'];
    let msg = '🤖 <b>BLUE.Y Status</b>\n\n';
    for (const ns of namespaces) {
      const pods = await kube.getPods(ns);
      const unhealthy = pods.filter(p =>
        (p.status !== 'Running' && p.status !== 'Succeeded') ||
        (!p.ready && p.status === 'Running') ||
        p.restarts > 5
      );
      msg += unhealthy.length > 0
        ? `❌ <b>${ns}</b>: ${unhealthy.length} issues / ${pods.length} pods\n`
        : `✅ <b>${ns}</b>: ${pods.length} pods healthy\n`;
    }
    return msg;
  }

  if (cmd === '/check' || cmd === 'check') {
    const namespaces = ['prod', 'doris', 'monitoring', 'wordpress'];
    let msg = '🔍 <b>BLUE.Y Full Check</b>\n\n';
    for (const ns of namespaces) {
      const pods = await kube.getPods(ns);
      const unhealthy = pods.filter(p =>
        (p.status !== 'Running' && p.status !== 'Succeeded') ||
        (!p.ready && p.status === 'Running') ||
        p.restarts > 5
      );
      if (unhealthy.length > 0) {
        msg += `❌ <b>${ns}</b>\n`;
        unhealthy.forEach(p => {
          const reason = p.containers.find(c => c.reason)?.reason || p.status;
          msg += `  • <code>${p.name}</code>\n    ${reason}, restarts: ${p.restarts}\n`;
        });
        msg += '\n';
      } else {
        msg += `✅ <b>${ns}</b> — all ${pods.length} pods healthy\n`;
      }
    }
    msg += `\n⏰ ${new Date().toISOString()}`;
    return msg;
  }

  if (cmd === '/nodes' || cmd === 'nodes') {
    const nodes = await kube.getNodes();
    let msg = '🖥️ <b>Nodes</b>\n\n';
    nodes.forEach(n => {
      const icon = n.status === 'Ready' ? '✅' : '❌';
      const mem = Math.round(parseInt(n.allocatable.memory) / 1024 / 1024);
      msg += `${icon} <code>${n.name.split('.')[0]}</code>\n   ${n.allocatable.cpu} CPU, ${mem}Gi RAM\n`;
    });
    return msg;
  }

  if (cmd.startsWith('/logs ')) {
    const podName = cmd.replace('/logs ', '').trim();
    const namespaces = ['prod', 'doris', 'monitoring', 'wordpress'];
    for (const ns of namespaces) {
      const pods = await kube.getPods(ns);
      const match = pods.find(p => p.name.includes(podName));
      if (match) {
        const logs = await kube.getPodLogs(ns, match.name, 20);
        return `📋 <b>Logs: ${match.name}</b>\n\n<pre>${logs.substring(0, 3500)}</pre>`;
      }
    }
    return `❓ Pod matching "${podName}" not found`;
  }

  return `👁️ <b>BLUE.Y Commands</b>\n\n/status — Quick health overview\n/check — Full pod scan\n/nodes — Node resources\n/logs &lt;pod-name&gt; — Tail pod logs`;
}

async function poll() {
  console.log('BLUE.Y polling started — listening for Telegram messages...');

  while (true) {
    try {
      const res = await axios.get(`${API}/getUpdates`, {
        params: { offset: lastUpdateId + 1, timeout: 30 },
        timeout: 35000,
      });

      for (const update of res.data.result || []) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text) continue;
        if (String(msg.chat.id) !== CHAT_ID) continue;

        console.log(`[${msg.from.first_name}]: ${msg.text}`);

        try {
          const reply = await handleMessage(msg.text);
          await sendMsg(reply);
          console.log('→ Replied');
        } catch (err) {
          console.error('Error handling message:', err.message);
          await sendMsg(`❌ Error: ${err.message}`);
        }
      }
    } catch (err) {
      if (err.code !== 'ECONNABORTED') {
        console.error('Poll error:', err.message);
      }
    }
  }
}

poll();
