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
import EmailTemplates from './pages/EmailTemplates';
import AlertRecipients from './pages/AlertRecipients';
import CiCd from './pages/CiCd';

export type Page = 'overview' | 'incidents' | 'cluster' | 'deployments' | 'logs' | 'cicd' | 'users' | 'integrations' | 'config' | 'email-templates' | 'alert-recipients';

export default function App() {
  const [page, setPage] = useState<Page>('overview');

  const content = {
    overview:          <Overview />,
    incidents:         <Incidents />,
    cluster:           <Cluster />,
    deployments:       <Deployments />,
    logs:              <Logs />,
    cicd:              <CiCd onNavigate={setPage} />,
    users:             <Users />,
    integrations:      <Integrations />,
    config:            <Config />,
    'email-templates':   <EmailTemplates />,
    'alert-recipients':  <AlertRecipients />,
  }[page];

  return (
    <Layout page={page} onNavigate={setPage}>
      {content}
    </Layout>
  );
}
