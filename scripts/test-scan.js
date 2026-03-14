const { KubeClient } = require('../dist/clients/kube');

async function test() {
  const kube = new KubeClient();

  console.log('=== BLUE.Y Test Run — Checking all namespaces ===\n');

  // Check pods
  const namespaces = ['prod', 'doris', 'monitoring', 'wordpress'];
  for (const ns of namespaces) {
    const pods = await kube.getPods(ns);
    const unhealthy = pods.filter(p =>
      (p.status !== 'Running' && p.status !== 'Succeeded') ||
      (!p.ready && p.status === 'Running') ||
      p.restarts > 5
    );

    console.log('--- Namespace: ' + ns + ' ---');
    console.log('Total pods: ' + pods.length + ', Unhealthy: ' + unhealthy.length);

    if (unhealthy.length > 0) {
      unhealthy.forEach(p => {
        console.log('  ❌ ' + p.name + ': status=' + p.status + ', ready=' + p.ready + ', restarts=' + p.restarts);
        p.containers.forEach(c => {
          if (c.reason) console.log('     Container ' + c.name + ': ' + c.reason);
        });
      });
    } else {
      console.log('  ✅ All healthy');
    }
    console.log();
  }

  // Check nodes
  const nodes = await kube.getNodes();
  console.log('--- Nodes ---');
  nodes.forEach(n => {
    const icon = n.status === 'Ready' ? '✅' : '❌';
    console.log(icon + ' ' + n.name + ': ' + n.status + ' (CPU: ' + n.allocatable.cpu + ', Mem: ' + n.allocatable.memory + ')');
    n.conditions.filter(c => c.type !== 'Ready' && c.status === 'True').forEach(c => {
      console.log('  ⚠️  ' + c.type + ': ' + c.reason);
    });
  });
}

test().catch(console.error);
