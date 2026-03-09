import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config';
import { logger } from '../utils/logger';

interface AnalysisRequest {
  type: 'pod_issue' | 'node_issue' | 'cert_issue' | 'user_command' | 'incident';
  message: string;
  context?: Record<string, unknown>;
  from?: string;
}

interface AnalysisResponse {
  analysis: string;
  severity: 'info' | 'warning' | 'critical';
  requiresAction: boolean;
  suggestedAction?: string;
  suggestedCommand?: string;
}

const SYSTEM_PROMPT = `You are BLUE.Y, an AI ops assistant for BlueOnion's Kubernetes infrastructure on AWS EKS (cluster: blo-cluster, region: ap-southeast-1).

Your role:
- Analyze infrastructure alerts and provide clear, actionable summaries
- Suggest fixes when pods crash, nodes are unhealthy, or certs expire
- NEVER suggest destructive commands (delete PVC, delete namespace, drain node)
- NEVER touch Doris PVC or Doris namespace storage
- Keep responses concise — this goes to WhatsApp (max ~1000 chars)

Key infrastructure:
- Namespaces: prod (main apps), doris (analytics DB), monitoring (Prometheus/Grafana), wordpress
- Critical pods: jcp-blo-backend (Java, 18GB), doris-be/fe, user-management-be/fe, blue-ai
- Doris: Analytics DB with 151 tables, 90GB data — NEVER touch its PVC

When suggesting kubectl commands, only suggest safe read or restart commands:
- kubectl get pods/logs/describe (read-only)
- kubectl rollout restart deployment (safe restart)
- kubectl scale deployment (safe scaling)

Response format (JSON):
{
  "analysis": "human-readable summary",
  "severity": "info|warning|critical",
  "requiresAction": true/false,
  "suggestedAction": "what to do (human-readable)",
  "suggestedCommand": "kubectl command if applicable"
}`;

export class BedrockClient {
  private client: BedrockRuntimeClient;

  constructor() {
    this.client = new BedrockRuntimeClient({ region: config.bedrock.region });
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResponse> {
    // Use Opus for incidents, Sonnet for routine checks
    const modelId = request.type === 'incident' || request.type === 'user_command'
      ? config.bedrock.incidentModel
      : config.bedrock.routineModel;

    logger.info(`Bedrock request: type=${request.type}, model=${modelId}`);

    try {
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: config.bedrock.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: this.buildPrompt(request),
          },
        ],
      });

      const command = new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: new TextEncoder().encode(body),
      });

      const response = await this.client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      const text = responseBody.content?.[0]?.text || '';

      // Try to parse structured JSON response
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch {
        // Fall back to unstructured response
      }

      return {
        analysis: text,
        severity: 'info',
        requiresAction: false,
      };
    } catch (err) {
      logger.error(`Bedrock invocation failed: ${err}`);
      return {
        analysis: `Error analyzing: ${err instanceof Error ? err.message : 'Unknown error'}`,
        severity: 'warning',
        requiresAction: false,
      };
    }
  }

  private buildPrompt(request: AnalysisRequest): string {
    switch (request.type) {
      case 'pod_issue':
        return `Pod issue detected:\n${request.message}\n\nContext: ${JSON.stringify(request.context || {})}\n\nAnalyze the issue and suggest a fix.`;
      case 'node_issue':
        return `Node issue detected:\n${request.message}\n\nContext: ${JSON.stringify(request.context || {})}\n\nAnalyze the node health issue.`;
      case 'cert_issue':
        return `Certificate issue:\n${request.message}\n\nCheck expiry and suggest renewal steps.`;
      case 'user_command':
        return `Operator command: "${request.message}"\n\nAnalyze what the operator is asking and provide a response. If they're asking to perform an action, include the suggested kubectl command.`;
      case 'incident':
        return `INCIDENT:\n${request.message}\n\nContext: ${JSON.stringify(request.context || {})}\n\nThis is a critical incident. Provide detailed root cause analysis and remediation steps.`;
      default:
        return request.message;
    }
  }
}
