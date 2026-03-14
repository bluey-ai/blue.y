const { KubeClient } = require('../dist/clients/kube');
const axios = require('axios');

const BOT_TOKEN = '8781856722:AAEBbMoM_cMobvtkT5NqFX2LX6-x_DTh4lE';
const CHAT_ID = '-5250662902';

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function test() {
  const kube = new KubeClient();

  let report = '🔍 <b>BLUE.Y Infrastructure Scan</b>\n\n';

  const namespaces = ['prod', 'doris', 'monitoring', 'wordpress'];
  let totalIssues = 0;

  for (const ns of namespaces) {
    const pods = await kube.getPods(ns);
    const unhealthy = pods.filter(p =>
      (p.status !== 'Running' && p.status !== 'Succeeded') ||
      (!p.ready && p.status === 'Running') ||
      p.restarts > 5
    );

    if (unhealthy.length > 0) {
      report += `❌ <b>${ns}</b> (${unhealthy.length} issues)\n`;
      unhealthy.forEach(p => {
        const reason = p.containers.find(c => c.reason)?.reason || p.status;
        report += `  • ${p.name}: ${reason} (restarts: ${p.restarts})\n`;
      });
      report += '\n';
      totalIssues += unhealthy.length;
    } else {
      report += `✅ <b>${ns}</b> — ${pods.length} pods healthy\n`;
    }
  }

  const nodes = await kube.getNodes();
  report += `\n🖥️ <b>Nodes</b> (${nodes.length})\n`;
  nodes.forEach(n => {
    const icon = n.status === 'Ready' ? '✅' : '❌';
    report += `${icon} ${n.name.split('.')[0]}: ${n.allocatable.cpu} CPU, ${Math.round(parseInt(n.allocatable.memory) / 1024 / 1024)}Gi RAM\n`;
  });

  report += `\n⏰ ${new Date().toISOString()}`;

  await sendTelegram(report);
  console.log('Scan sent to Telegram!');
}

test().catch(console.error);
