import { useState } from 'react';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import Incidents from './pages/Incidents';
import Cluster from './pages/Cluster';
import Users from './pages/Users';
import Config from './pages/Config';

export type Page = 'overview' | 'incidents' | 'cluster' | 'users' | 'config';

export default function App() {
  const [page, setPage] = useState<Page>('overview');

  const content = {
    overview:  <Overview />,
    incidents: <Incidents />,
    cluster:   <Cluster />,
    users:     <Users />,
    config:    <Config />,
  }[page];

  return (
    <Layout page={page} onNavigate={setPage}>
      {content}
    </Layout>
  );
}
