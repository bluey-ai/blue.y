import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const BB_API = 'https://api.bitbucket.org/2.0';
const BB_WORKSPACE = 'blue-onion';

// Pipeline definitions (branch → display label)
export const PIPELINES: Record<string, Record<string, Array<{ branch: string; label: string; env: 'prod' | 'stg' | 'dev' }>>> = {
  'jcp-blo-backend': {
    prod: [
      { branch: 'production-hubs20', label: 'Production Hubs20 ★', env: 'prod' },
    ],
    stg: [
      { branch: 'staging-hubs20', label: 'Staging Hubs20', env: 'stg' },
      { branch: 'stg-hubs-backend', label: 'Staging Hubs', env: 'stg' },
      { branch: 'stg-crm', label: 'Staging CRM', env: 'stg' },
      { branch: 'stg-stewardship', label: 'Staging Stewardship', env: 'stg' },
    ],
    dev: [
      { branch: 'develop-hubs20', label: 'Dev Hubs20', env: 'dev' },
      { branch: 'develop-hubs10', label: 'Dev Hubs10', env: 'dev' },
      { branch: 'develop-fund-update-pwc', label: 'Dev Pwc', env: 'dev' },
      { branch: 'develop-stewardshiphub', label: 'Dev Stewardshiphub', env: 'dev' },
    ],
  },
  'jcp-blo-frontend': {
    prod: [
      { branch: 'production-fund-update', label: 'Production Fund Update ★', env: 'prod' },
      { branch: 'basprod-frontend', label: 'Production BAS', env: 'prod' },
      { branch: 'production-fund-bloconnect', label: 'Production BloConnect', env: 'prod' },
    ],
    stg: [
      { branch: 'staging-hubs', label: 'Staging Hubs', env: 'stg' },
      { branch: 'staging-fund-update', label: 'Staging Fund Update', env: 'stg' },
    ],
    dev: [
      { branch: 'develop-hubs', label: 'Dev Hubs', env: 'dev' },
      { branch: 'develop-fund-update', label: 'Dev Fund Update', env: 'dev' },
      { branch: 'develop-bas', label: 'Dev BAS', env: 'dev' },
    ],
  },
  'user-management-be': {
    prod: [{ branch: 'feature/aws-account-migration', label: 'Production', env: 'prod' }],
    stg: [],
    dev: [],
  },
  'user-management-fe': {
    prod: [{ branch: 'feature/aws-account-migration', label: 'Production', env: 'prod' }],
    stg: [],
    dev: [],
  },
  'pdf-service': {
    prod: [{ branch: 'feature/aws-account-migration', label: 'Production', env: 'prod' }],
    stg: [],
    dev: [],
  },
  'blue.y': {
    prod: [{ branch: 'main', label: 'Production', env: 'prod' }],
    stg: [],
    dev: [],
  },
};

export interface PipelineInfo {
  uuid: string;
  buildNumber: number;
  branch: string;
  state: string;
  result: string;
  durationSeconds: number;
  createdOn: string;
  url: string;
}

export class BitbucketClient {
  private token: string | null = null;

  constructor() {
    if (config.bitbucket.token) {
      this.token = config.bitbucket.token;
    }
  }

  get enabled(): boolean {
    return this.token !== null;
  }

  private get headers() {
    if (!this.token) throw new Error('Bitbucket not configured');
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Bitbucket API tokens use Bearer auth (App Passwords are deprecated)
      'Authorization': `Bearer ${this.token}`,
    };
  }

  /**
   * Trigger a pipeline on a specific repo/branch.
   */
  async triggerPipeline(repo: string, branch: string): Promise<PipelineInfo> {
    const response = await axios.post(
      `${BB_API}/repositories/${BB_WORKSPACE}/${repo}/pipelines/`,
      {
        target: {
          type: 'pipeline_ref_target',
          ref_type: 'branch',
          ref_name: branch,
          selector: { type: 'branches' },
        },
      },
      { headers: this.headers, timeout: 15000 },
    );

    const p = response.data;
    return {
      uuid: (p.uuid || '').replace(/[{}]/g, ''),
      buildNumber: p.build_number,
      branch: p.target?.ref_name || branch,
      state: p.state?.name || 'PENDING',
      result: p.state?.result?.name || '',
      durationSeconds: 0,
      createdOn: p.created_on || new Date().toISOString(),
      url: `https://bitbucket.org/${BB_WORKSPACE}/${repo}/pipelines/results/${p.build_number}`,
    };
  }

  /**
   * Get status of a specific pipeline.
   */
  async getPipelineStatus(repo: string, uuid: string): Promise<PipelineInfo> {
    const response = await axios.get(
      `${BB_API}/repositories/${BB_WORKSPACE}/${repo}/pipelines/${uuid}`,
      { headers: this.headers, timeout: 10000 },
    );

    const p = response.data;
    return {
      uuid: (p.uuid || '').replace(/[{}]/g, ''),
      buildNumber: p.build_number,
      branch: p.target?.ref_name || '',
      state: p.state?.name || 'UNKNOWN',
      result: p.state?.result?.name || '',
      durationSeconds: p.duration_in_seconds || 0,
      createdOn: p.created_on || '',
      url: `https://bitbucket.org/${BB_WORKSPACE}/${repo}/pipelines/results/${p.build_number}`,
    };
  }

  /**
   * Get recent pipelines for a repo.
   */
  async getRecentPipelines(repo: string, limit = 8): Promise<PipelineInfo[]> {
    const response = await axios.get(
      `${BB_API}/repositories/${BB_WORKSPACE}/${repo}/pipelines/?sort=-created_on&pagelen=${limit}`,
      { headers: this.headers, timeout: 10000 },
    );

    return (response.data.values || []).map((p: Record<string, unknown>) => {
      const state = p.state as Record<string, unknown> || {};
      const result = state.result as Record<string, unknown> || {};
      const target = p.target as Record<string, unknown> || {};
      return {
        uuid: (String(p.uuid || '')).replace(/[{}]/g, ''),
        buildNumber: p.build_number as number,
        branch: String(target.ref_name || ''),
        state: String(state.name || 'UNKNOWN'),
        result: String(result.name || ''),
        durationSeconds: (p.duration_in_seconds as number) || 0,
        createdOn: String(p.created_on || ''),
        url: `https://bitbucket.org/${BB_WORKSPACE}/${repo}/pipelines/results/${p.build_number}`,
      };
    });
  }

  /**
   * Find a pipeline definition by search term.
   * Matches against repo name, branch, label, or shortcuts like "backend prod", "bas", "frontend stg"
   */
  findPipeline(search: string): Array<{ repo: string; branch: string; label: string; env: string }> {
    const s = search.toLowerCase().trim();
    const results: Array<{ repo: string; branch: string; label: string; env: string }> = [];

    // Shortcut mappings
    const repoAliases: Record<string, string[]> = {
      'backend': ['jcp-blo-backend'],
      'be': ['jcp-blo-backend'],
      'frontend': ['jcp-blo-frontend'],
      'fe': ['jcp-blo-frontend'],
      'um-be': ['user-management-be'],
      'um-fe': ['user-management-fe'],
      'pdf': ['pdf-service'],
      'bluey': ['blue.y'],
    };

    for (const [repo, envs] of Object.entries(PIPELINES)) {
      for (const [env, pipelines] of Object.entries(envs)) {
        for (const p of pipelines) {
          const searchable = `${repo} ${p.branch} ${p.label} ${env}`.toLowerCase();

          // Check aliases
          let aliasMatch = false;
          for (const [alias, repos] of Object.entries(repoAliases)) {
            if (s.includes(alias) && repos.includes(repo)) {
              aliasMatch = true;
              break;
            }
          }

          // Match if: alias matches + env matches, or search terms are in searchable string
          const envMatch = s.includes(env) || s.includes('prod') && env === 'prod' || s.includes('stg') && env === 'stg' || s.includes('staging') && env === 'stg' || s.includes('dev') && env === 'dev';

          if ((aliasMatch && envMatch) || s.split(/\s+/).every((word) => searchable.includes(word))) {
            results.push({ repo, branch: p.branch, label: p.label, env });
          }
        }
      }
    }

    return results;
  }

  /**
   * Get commits between two refs (for deployment diff).
   */
  async getCommitsBetween(repo: string, branch: string, limit = 10): Promise<Array<{ hash: string; message: string; author: string; date: string }>> {
    try {
      const response = await axios.get(
        `${BB_API}/repositories/${BB_WORKSPACE}/${repo}/commits/${encodeURIComponent(branch)}?pagelen=${limit}`,
        { headers: this.headers, timeout: 10000 },
      );

      return (response.data.values || []).map((c: Record<string, unknown>) => ({
        hash: String(c.hash || '').substring(0, 7),
        message: String((c.message as string) || '').split('\n')[0].substring(0, 80),
        author: ((c.author as Record<string, unknown>)?.user as Record<string, unknown>)?.display_name as string || String((c.author as Record<string, string>)?.raw || '').split('<')[0].trim(),
        date: String(c.date || ''),
      }));
    } catch (err) {
      logger.error(`Failed to get commits for ${repo}/${branch}: ${err}`);
      return [];
    }
  }

  /**
   * Format pipeline status icon.
   */
  static statusIcon(state: string, result: string): string {
    const status = result || state;
    switch (status) {
      case 'SUCCESSFUL': return '✅';
      case 'FAILED': case 'ERROR': return '❌';
      case 'IN_PROGRESS': return '⏳';
      case 'PENDING': return '⏸️';
      case 'STOPPED': case 'EXPIRED': return '⏹️';
      default: return '❓';
    }
  }

  /**
   * Format a pipeline info for Telegram.
   */
  static formatPipeline(p: PipelineInfo): string {
    const icon = BitbucketClient.statusIcon(p.state, p.result);
    const mins = Math.floor(p.durationSeconds / 60);
    const secs = p.durationSeconds % 60;
    const duration = p.durationSeconds > 0 ? `${mins}m${secs.toString().padStart(2, '0')}s` : '-';
    return `${icon} #${p.buildNumber} <b>${p.branch}</b> — ${p.result || p.state} (${duration})`;
  }

  /**
   * Format list of available pipelines for Telegram.
   */
  formatPipelineList(): string {
    let msg = '🔧 <b>Available Pipelines</b>\n\n';

    for (const [repo, envs] of Object.entries(PIPELINES)) {
      const shortRepo = repo.replace('jcp-blo-', '');
      msg += `<b>${shortRepo}</b>\n`;
      for (const [env, pipelines] of Object.entries(envs)) {
        if (pipelines.length === 0) continue;
        const envIcon = env === 'prod' ? '🔴' : env === 'stg' ? '🟡' : '🟢';
        for (const p of pipelines) {
          msg += `  ${envIcon} ${p.label} (<code>${p.branch}</code>)\n`;
        }
      }
      msg += '\n';
    }

    msg += '💡 Usage: /build backend prod\n';
    msg += '/builds — Recent builds';
    return msg;
  }
}
