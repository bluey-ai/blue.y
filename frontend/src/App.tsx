import { useState } from 'react';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import Incidents from './pages/Incidents';
import Cluster from './pages/Cluster';
import Users from './pages/Users';
import Config from './pages/Config';
import Logs from './pages/Logs';
import Deployments from './pages/Deployments';
import Integrations from './pages/Integrations';

export type Page = 'overview' | 'incidents' | 'cluster' | 'deployments' | 'logs' | 'users' | 'integrations' | 'config';

export default function App() {
  const [page, setPage] = useState<Page>('overview');

  const content = {
    overview:     <Overview />,
    incidents:    <Incidents />,
    cluster:      <Cluster />,
    deployments:  <Deployments />,
    logs:         <Logs />,
    users:        <Users />,
    integrations: <Integrations />,
    config:       <Config />,
  }[page];

  return (
    <Layout page={page} onNavigate={setPage}>
      {content}
    </Layout>
  );
}
