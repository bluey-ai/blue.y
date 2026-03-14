import { BitbucketClient } from './bitbucket';
import { BedrockClient } from './bedrock';
import { logger } from '../utils/logger';

export interface ScanFinding {
  severity: 'critical' | 'high' | 'medium' | 'info';
  type: string;
  file: string;
  line?: number;
  detail: string;
}

export interface ScanResult {
  repo: string;
  branch: string;
  filesScanned: number;
  commitCount: number;
  findings: ScanFinding[];
  aiSummary?: string;
  scannedAt: Date;
}

// File extensions worth scanning
const SCANNABLE_EXTENSIONS = new Set([
  'java', 'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rb', 'php',
  'xml', 'yaml', 'yml', 'properties', 'env', 'conf', 'config',
  'sh', 'bash', 'sql', 'tf', 'json',
]);

// Files/paths to always skip
const SKIP_PATTERNS = [
  /node_modules\//,
  /\.min\.js$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pom\.xml$/,          // Maven — no secrets usually
  /\.map$/,
  /dist\//,
  /target\//,
  /\.class$/,
  /\.jar$/,
];

// Secret detection patterns (regex — fast, zero cost)
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp; severity: 'critical' | 'high' }> = [
  { name: 'AWS Access Key',       pattern: /AKIA[0-9A-Z]{16}/,                                          severity: 'critical' },
  { name: 'AWS Secret Key',       pattern: /aws.{0,20}secret.{0,10}[=:]\s*['"][0-9a-zA-Z/+]{40}['"]/i, severity: 'critical' },
  { name: 'Private Key (PEM)',    pattern: /-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/,           severity: 'critical' },
  { name: 'Hardcoded Password',   pattern: /password\s*[=:]\s*['"][^'"${}]{8,}['"]/i,                   severity: 'critical' },
  { name: 'Hardcoded DB URL',     pattern: /(?:mysql|postgres|mongodb|jdbc):\/\/[^:@\s]+:[^@\s]+@/i,    severity: 'critical' },
  { name: 'Hardcoded API Key',    pattern: /api[_-]?key\s*[=:]\s*['"][^'"${}]{16,}['"]/i,              severity: 'high' },
  { name: 'Hardcoded Token',      pattern: /(?:token|secret)\s*[=:]\s*['"][^'"${}]{20,}['"]/i,          severity: 'high' },
  { name: 'JWT Secret',           pattern: /jwt[_.-]?secret\s*[=:]\s*['"][^'"${}]{10,}['"]/i,           severity: 'high' },
  { name: 'Hardcoded Private IP', pattern: /['"]10\.50\.\d+\.\d+['"]/,                                  severity: 'high' },
  { name: 'Base64 Secret',        pattern: /(?:password|secret|key)\s*=\s*['"][A-Za-z0-9+/]{40,}={0,2}['"]/, severity: 'high' },
];

// Vulnerability patterns (regex — code smell level)
const VULN_PATTERNS: Array<{ name: string; pattern: RegExp; severity: 'high' | 'medium' }> = [
  { name: 'SQL Injection Risk',         pattern: /['"]\s*\+\s*(?:req|request|param|input|user|query)\./i,   severity: 'high' },
  { name: 'Command Injection Risk',     pattern: /Runtime\.getRuntime\(\)\.exec\(|ProcessBuilder|exec\(.*\+/,  severity: 'high' },
  { name: 'Eval (JS)',                  pattern: /\beval\s*\((?!\/\/)/,                                      severity: 'high' },
  { name: 'Deserialization Risk',       pattern: /ObjectInputStream|readObject\(\)|pickle\.loads/,            severity: 'high' },
  { name: 'Path Traversal Risk',        pattern: /\.\.\/|\.\.\\|getFile\(.*req\.|new File\(.*\+/,            severity: 'medium' },
  { name: 'SSRF Risk',                  pattern: /new URL\s*\(\s*(?:req|request|param|input)\./i,            severity: 'medium' },
  { name: 'Hardcoded Debug/Test Flag',  pattern: /debug\s*=\s*true|test\s*=\s*true|isDev\s*=\s*true/i,      severity: 'medium' },
  { name: 'TODO Security',              pattern: /TODO.*(?:security|auth|fix|hack|vulnerable)/i,              severity: 'medium' },
  { name: 'Suspicious Outbound',        pattern: /curl|wget|fetch.*(?:http|ftp):\/\/(?!api\.|localhost|127\.)/i, severity: 'medium' },
];

export class SecurityScanner {
  constructor(
    private bb: BitbucketClient,
    private bedrock: BedrockClient,
  ) {}

  /**
   * Scan recent commits on a branch for security issues.
   */
  async scanRepo(repo: string, branch: string, commitCount = 5, maxFiles = 20): Promise<ScanResult> {
    const result: ScanResult = {
      repo,
      branch,
      filesScanned: 0,
      commitCount: 0,
      findings: [],
      scannedAt: new Date(),
    };

    // 1. Get recent commits
    const commits = await this.bb.getCommitsBetween(repo, branch, commitCount);
    if (commits.length === 0) {
      return result;
    }
    result.commitCount = commits.length;

    // 2. Collect changed files across all commits (deduplicated)
    const fileSet = new Map<string, string>(); // path → commit hash
    for (const commit of commits) {
      const changed = await this.bb.getChangedFiles(repo, commit.hash);
      for (const f of changed) {
        if (!fileSet.has(f.path) && f.status !== 'removed') {
          fileSet.set(f.path, commit.hash);
        }
      }
    }

    // 3. Filter to scannable files
    const toScan = [...fileSet.entries()]
      .filter(([path]) => {
        const ext = path.split('.').pop()?.toLowerCase() || '';
        if (!SCANNABLE_EXTENSIONS.has(ext)) return false;
        if (SKIP_PATTERNS.some((p) => p.test(path))) return false;
        return true;
      })
      .slice(0, maxFiles);

    // 4. Fetch and scan each file
    const aiFiles: Array<{ path: string; content: string }> = [];

    for (const [path, hash] of toScan) {
      try {
        const content = await this.bb.getFileContent(repo, hash, path);
        if (!content || content.length > 100_000) continue; // skip empty or huge files

        result.filesScanned++;

        // Regex secret scan
        for (const { name, pattern, severity } of SECRET_PATTERNS) {
          const match = content.match(pattern);
          if (match) {
            const line = this.findLineNumber(content, match[0]);
            result.findings.push({
              severity,
              type: name,
              file: path,
              line,
              detail: this.redact(match[0]),
            });
          }
        }

        // Regex vuln scan
        for (const { name, pattern, severity } of VULN_PATTERNS) {
          const match = content.match(pattern);
          if (match) {
            const line = this.findLineNumber(content, match[0]);
            result.findings.push({
              severity,
              type: name,
              file: path,
              line,
              detail: match[0].substring(0, 100).trim(),
            });
          }
        }

        // Collect for AI review (limit total content)
        const totalAiChars = aiFiles.reduce((s, f) => s + f.content.length, 0);
        if (totalAiChars < 40_000) {
          aiFiles.push({ path, content: content.substring(0, 4000) });
        }
      } catch (err) {
        logger.warn(`[Scanner] Failed to fetch ${repo}/${path}: ${err}`);
      }
    }

    // 5. AI deep review on collected files
    if (aiFiles.length > 0) {
      try {
        const aiFindings = await this.aiReview(repo, branch, aiFiles);
        result.aiSummary = aiFindings;
      } catch (err) {
        logger.warn(`[Scanner] AI review failed: ${err}`);
      }
    }

    return result;
  }

  /**
   * Send files to DeepSeek for AI-powered security analysis.
   */
  private async aiReview(repo: string, branch: string, files: Array<{ path: string; content: string }>): Promise<string> {
    const fileBlock = files.map((f) =>
      `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``,
    ).join('\n\n');

    const prompt = `You are a senior application security engineer doing a code security review.

Repository: ${repo} (branch: ${branch})
Files changed in recent commits:

${fileBlock}

Review for:
1. Hardcoded credentials, secrets, API keys, tokens
2. SQL injection, command injection, path traversal, SSRF
3. Insecure deserialization, eval usage
4. Backdoors, suspicious outbound connections, unusual encoded payloads
5. Authentication/authorization bypasses
6. Exposed debug endpoints or test flags in production code

For each issue found, provide:
- SEVERITY: critical/high/medium/info
- FILE: the file path
- ISSUE: short description
- DETAIL: the specific code snippet or pattern (max 1 line)
- FIX: one-line recommendation

If no issues found, say "✅ No security issues found in the reviewed files."

Be concise. Focus only on real, actionable security issues — not style or performance.`;

    const response = await this.bedrock.analyzeRaw(prompt);
    return response;
  }

  private findLineNumber(content: string, match: string): number {
    const idx = content.indexOf(match);
    if (idx === -1) return 0;
    return content.substring(0, idx).split('\n').length;
  }

  private redact(match: string): string {
    // Show first 15 chars then mask the rest
    const visible = match.substring(0, 15);
    return `${visible}${'*'.repeat(Math.min(10, match.length - 15))}`;
  }

  formatForTelegram(result: ScanResult): string {
    const criticalCount = result.findings.filter((f) => f.severity === 'critical').length;
    const highCount = result.findings.filter((f) => f.severity === 'high').length;
    const mediumCount = result.findings.filter((f) => f.severity === 'medium').length;

    const statusIcon = criticalCount > 0 ? '🔴' : highCount > 0 ? '🟡' : '🟢';

    let msg = `${statusIcon} <b>Security Scan: ${result.repo}</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📁 Branch: <code>${result.branch}</code>\n`;
    msg += `📝 Files scanned: <b>${result.filesScanned}</b> (${result.commitCount} commits)\n`;
    msg += `🔍 Findings: 🔴 ${criticalCount} critical  🟡 ${highCount} high  🟠 ${mediumCount} medium\n\n`;

    if (result.findings.length === 0 && !result.aiSummary) {
      msg += `✅ No security issues detected.\n`;
      return msg;
    }

    // Group by severity
    const bySeverity = ['critical', 'high', 'medium', 'info'] as const;
    for (const sev of bySeverity) {
      const items = result.findings.filter((f) => f.severity === sev);
      if (items.length === 0) continue;

      const sevIcon = sev === 'critical' ? '🔴' : sev === 'high' ? '🟡' : sev === 'medium' ? '🟠' : '🔵';
      msg += `<b>${sevIcon} ${sev.toUpperCase()} (${items.length})</b>\n`;

      for (const f of items.slice(0, 5)) {
        msg += `  • <b>${f.type}</b>\n`;
        msg += `    File: <code>${f.file}${f.line ? `:${f.line}` : ''}</code>\n`;
        msg += `    <code>${f.detail}</code>\n`;
      }
      if (items.length > 5) msg += `  … +${items.length - 5} more\n`;
      msg += '\n';
    }

    // AI summary
    if (result.aiSummary) {
      msg += `<b>🧠 AI Review:</b>\n${result.aiSummary.substring(0, 800)}\n`;
      if (result.aiSummary.length > 800) msg += '…(truncated)\n';
    }

    return msg;
  }
}
