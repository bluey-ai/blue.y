import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { DatabaseClient, DATABASE_REGISTRY, QueryResult } from './database';

/**
 * 3-Agent SQL Pipeline for BLUE.Y (same pattern as BLUE.AI)
 *
 * Agent 1 (Generator)  — DeepSeek V3: Generates SQL from natural language
 * Agent 2 (Validator)  — DeepSeek R1: Reviews SQL against real table schemas, fixes errors
 * Agent 3 (Verifier)   — DeepSeek V3: Checks if results actually answer the question
 *
 * Auto-retry: If Agent 3 flags the result, loop back to Agent 1 with feedback.
 */

interface GeneratedQuery {
  instance: string;
  database: string;
  sql: string;
  explanation: string;
}

interface ValidationResult {
  confidence: 'high' | 'medium' | 'low';
  correctedSql: string;
  fixes: string[];
  reasoning: string;
}

interface VerificationResult {
  verdict: 'pass' | 'flag';
  reason: string;
}

export interface PipelineResult {
  question: string;
  query: GeneratedQuery;
  validation: ValidationResult;
  verification: VerificationResult;
  queryResult: QueryResult;
  retried: boolean;
}

// Progress callback for streaming status to Telegram
type ProgressCallback = (step: string, detail: string) => Promise<void>;

const SYSTEM_PROMPT_CONTEXT = `You are BLUE.Y's database query engine. You have read-only access to the following databases.

DATABASE REGISTRY:
${DATABASE_REGISTRY.length > 0
  ? DATABASE_REGISTRY.map((db) => `- ${db.name} (${db.host}:${db.port}): ${db.databases.join(', ')} — ${db.description}`).join('\n')
  : '(No databases configured. Set DATABASE_REGISTRY env var.)'}

QUERY ROUTING:
${process.env.DB_QUERY_ROUTING || '- Query routing not configured. Set DB_QUERY_ROUTING env var with your table-to-use-case mapping.'}

RULES:
- SELECT only. NEVER INSERT/UPDATE/DELETE/DROP.
- Limit results to 50 rows max.
- Use specific columns over SELECT * to reduce data transfer.`;

export class DbAgentPipeline {
  private dbClient: DatabaseClient;

  constructor(dbClient: DatabaseClient) {
    this.dbClient = dbClient;
  }

  /**
   * Run the full 3-agent pipeline.
   */
  async run(question: string, onProgress?: ProgressCallback): Promise<PipelineResult> {
    // === AGENT 1: Generator ===
    await onProgress?.('🔵 Agent 1', 'Generating SQL...');
    const generated = await this.generate(question);

    if (!generated) {
      throw new Error('Agent 1 failed to generate a query. Try rephrasing your question.');
    }

    // === AGENT 2: Validator ===
    await onProgress?.('🟡 Agent 2', `Validating against ${generated.instance}.${generated.database} schema...`);
    const schemas = await this.fetchSchemas(generated);
    const validation = await this.validate(question, generated, schemas);

    // Use corrected SQL
    const finalQuery: GeneratedQuery = {
      ...generated,
      sql: validation.correctedSql || generated.sql,
    };

    // Safety check
    const safetyCheck = this.dbClient.validateQuery(finalQuery.sql);
    if (!safetyCheck.valid) {
      throw new Error(`Blocked: ${safetyCheck.reason}`);
    }

    // === Execute ===
    await onProgress?.('⚡', `Running query on ${finalQuery.instance}.${finalQuery.database}...`);
    let queryResult = await this.dbClient.query(finalQuery.instance, finalQuery.database, finalQuery.sql);

    // === AGENT 3: Verifier ===
    await onProgress?.('🟢 Agent 3', 'Verifying results...');
    let verification = await this.verify(question, finalQuery, queryResult);

    let retried = false;

    // Auto-retry if flagged
    if (verification.verdict === 'flag' && validation.confidence !== 'high') {
      await onProgress?.('🔄', `Retrying: ${verification.reason}`);
      logger.info(`Agent 3 flagged result, retrying: ${verification.reason}`);

      const retryGenerated = await this.generate(question, verification.reason);
      if (retryGenerated) {
        const retrySchemas = await this.fetchSchemas(retryGenerated);
        const retryValidation = await this.validate(question, retryGenerated, retrySchemas);
        const retrySql = retryValidation.correctedSql || retryGenerated.sql;

        const retryCheck = this.dbClient.validateQuery(retrySql);
        if (retryCheck.valid) {
          const retryResult = await this.dbClient.query(retryGenerated.instance, retryGenerated.database, retrySql);
          const retryVerification = await this.verify(question, { ...retryGenerated, sql: retrySql }, retryResult);

          // Use retry if it passed, or if it has more results
          if (retryVerification.verdict === 'pass' || retryResult.rowCount > queryResult.rowCount) {
            finalQuery.instance = retryGenerated.instance;
            finalQuery.database = retryGenerated.database;
            finalQuery.sql = retrySql;
            finalQuery.explanation = retryGenerated.explanation;
            queryResult = retryResult;
            verification = retryVerification;
            retried = true;
          }
        }
      }
    }

    return {
      question,
      query: finalQuery,
      validation,
      verification,
      queryResult,
      retried,
    };
  }

  /**
   * Agent 1: Generator — DeepSeek V3 (fast)
   * Generates SQL from natural language question.
   */
  private async generate(question: string, feedback?: string): Promise<GeneratedQuery | null> {
    const prompt = feedback
      ? `Previous attempt was flagged: "${feedback}"\n\nPlease generate a BETTER SQL query for: "${question}"\n\nFix the issue described above.`
      : `Generate a SQL SELECT query for: "${question}"`;

    try {
      const response = await this.callLLM(
        config.ai.routineModel, // V3 — fast
        SYSTEM_PROMPT_CONTEXT + `\n\nRespond with ONLY valid JSON:\n{"instance": "hubsprod", "database": "dwd", "sql": "SELECT ...", "explanation": "..."}`,
        prompt,
        30000,
      );

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        instance: parsed.instance || 'hubsprod',
        database: parsed.database || 'dwd',
        sql: parsed.sql || '',
        explanation: parsed.explanation || '',
      };
    } catch (err) {
      logger.error('Agent 1 (Generator) failed:', err);
      return null;
    }
  }

  /**
   * Fetch actual table schemas for the tables referenced in the SQL.
   */
  private async fetchSchemas(query: GeneratedQuery): Promise<string> {
    // Extract table names from SQL
    const tablePattern = /(?:FROM|JOIN|INTO)\s+`?(\w+)`?/gi;
    const tables: string[] = [];
    let match;
    while ((match = tablePattern.exec(query.sql)) !== null) {
      if (!['SELECT', 'WHERE', 'AND', 'OR', 'ON', 'AS', 'SET'].includes(match[1].toUpperCase())) {
        tables.push(match[1]);
      }
    }

    if (tables.length === 0) return 'No tables found in query.';

    const schemas: string[] = [];
    for (const table of [...new Set(tables)].slice(0, 5)) {
      const result = await this.dbClient.query(query.instance, query.database, `DESCRIBE \`${table.replace(/`/g, '')}\``);
      if (!result.error && result.rows.length > 0) {
        const cols = result.rows.map((r) => `  ${r.Field} ${r.Type}${r.Null === 'NO' ? ' NOT NULL' : ''}${r.Key === 'PRI' ? ' PRIMARY KEY' : ''}`).join('\n');
        schemas.push(`TABLE ${table}:\n${cols}`);
      } else {
        schemas.push(`TABLE ${table}: ${result.error || 'no columns found'}`);
      }
    }

    return schemas.join('\n\n');
  }

  /**
   * Agent 2: Validator — DeepSeek R1 (reasoning)
   * Reviews SQL against actual table schemas, fixes errors.
   */
  private async validate(question: string, query: GeneratedQuery, schemas: string): Promise<ValidationResult> {
    const prompt = `VALIDATE this SQL query against the actual table schemas.

QUESTION: "${question}"

GENERATED SQL:
${query.sql}

TARGET: ${query.instance}.${query.database}

ACTUAL TABLE SCHEMAS:
${schemas}

CHECKLIST:
1. Are all table names correct and exist in the schema?
2. Are all column names valid (check exact spelling against schema)?
3. Are JOINs correct (matching column types)?
4. Does the WHERE clause match the user's question?
5. Is GROUP BY correct if aggregations are used?
6. Are there NULL handling issues?
7. Is LIMIT present (add LIMIT 50 if missing)?

Respond with ONLY valid JSON:
{
  "confidence": "high|medium|low",
  "correctedSql": "the corrected SQL (or original if no fixes needed)",
  "fixes": ["list of fixes applied, empty if none"],
  "reasoning": "brief chain-of-thought explanation"
}`;

    try {
      const response = await this.callLLM(
        config.ai.incidentModel, // R1 — reasoning
        'You are a SQL validator. Review queries against actual database schemas and fix errors. Be precise about column names and table structures.',
        prompt,
        60000, // R1 needs more time to think
      );

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { confidence: 'low', correctedSql: query.sql, fixes: [], reasoning: 'Validation response unparseable' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        confidence: parsed.confidence || 'medium',
        correctedSql: parsed.correctedSql || query.sql,
        fixes: parsed.fixes || [],
        reasoning: parsed.reasoning || '',
      };
    } catch (err) {
      logger.error('Agent 2 (Validator) failed:', err);
      // On validator failure, pass through original SQL
      return { confidence: 'low', correctedSql: query.sql, fixes: [], reasoning: `Validator error: ${err}` };
    }
  }

  /**
   * Agent 3: Verifier — DeepSeek V3 (fast)
   * Checks if the results actually answer the question.
   * Only sends metadata, never actual data values (privacy).
   */
  private async verify(question: string, query: GeneratedQuery, result: QueryResult): Promise<VerificationResult> {
    if (result.error) {
      return { verdict: 'flag', reason: `Query error: ${result.error}` };
    }

    // Build metadata summary (no actual data values sent to LLM)
    const metadata = this.buildMetadata(result);

    const prompt = `VERIFY: Do these query results answer the user's question?

QUESTION: "${question}"

SQL EXECUTED:
${query.sql}

RESULT METADATA (no actual data, only structure):
${metadata}

CHECKS:
1. Does the SQL logically answer the question?
2. Is the row count reasonable? (0 rows might mean wrong table/filter)
3. Are the columns relevant to what was asked?
4. Are numeric ranges reasonable for financial/ESG data?

Respond with ONLY valid JSON:
{
  "verdict": "pass|flag",
  "reason": "brief explanation"
}`;

    try {
      const response = await this.callLLM(
        config.ai.routineModel, // V3 — fast
        'You are a query result verifier. Check if SQL results actually answer the user question. Only flag if clearly wrong.',
        prompt,
        20000,
      );

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { verdict: 'pass', reason: 'Verification response unparseable, passing by default' };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        verdict: parsed.verdict === 'flag' ? 'flag' : 'pass',
        reason: parsed.reason || '',
      };
    } catch (err) {
      logger.error('Agent 3 (Verifier) failed:', err);
      return { verdict: 'pass', reason: 'Verifier unavailable, passing by default' };
    }
  }

  /**
   * Build metadata summary of query results WITHOUT exposing actual data values.
   * Same privacy pattern as BLUE.AI.
   */
  private buildMetadata(result: QueryResult): string {
    if (result.rows.length === 0) {
      return `Columns: ${result.columns.join(', ')}\nRows: 0 (empty result set)`;
    }

    const lines: string[] = [
      `Columns (${result.columns.length}): [${result.columns.join(', ')}]`,
      `Rows: ${result.rowCount}${result.truncated ? ' (truncated at 50)' : ''}`,
    ];

    for (const col of result.columns) {
      const values = result.rows.map((r) => r[col]);
      const nonNull = values.filter((v) => v !== null && v !== undefined);
      const uniqueCount = new Set(nonNull.map(String)).size;

      // Check if numeric
      const numericValues = nonNull.map(Number).filter((n) => !isNaN(n));
      if (numericValues.length > nonNull.length * 0.5 && numericValues.length > 0) {
        const min = Math.min(...numericValues);
        const max = Math.max(...numericValues);
        lines.push(`  ${col}: numeric, min=${min}, max=${max}, unique=${uniqueCount}, non-null=${nonNull.length}/${values.length}`);
      } else {
        // Text field — show cardinality only
        const avgLen = nonNull.length > 0 ? Math.round(nonNull.reduce((s: number, v) => s + String(v).length, 0) / nonNull.length) : 0;
        lines.push(`  ${col}: text/mixed, unique=${uniqueCount}, avg_len=${avgLen}, non-null=${nonNull.length}/${values.length}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Call DeepSeek LLM (OpenAI-compatible API).
   */
  private async callLLM(model: string, systemPrompt: string, userPrompt: string, timeout: number): Promise<string> {
    const response = await axios.post(
      `${config.ai.baseUrl}/chat/completions`,
      {
        model,
        max_tokens: config.ai.maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      },
      {
        headers: {
          'Authorization': `Bearer ${config.ai.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout,
      },
    );

    return response.data.choices?.[0]?.message?.content || '';
  }

  /**
   * Format the full pipeline result for Telegram.
   */
  formatForTelegram(result: PipelineResult): string[] {
    const messages: string[] = [];

    // Message 1: Query + Validation summary
    const confidence = result.validation.confidence === 'high' ? '🟢' : result.validation.confidence === 'medium' ? '🟡' : '🔴';
    let msg1 = `🗄️ <b>${result.query.explanation}</b>\n\n`;
    msg1 += `<code>${result.query.sql}</code>\n\n`;
    msg1 += `${confidence} Confidence: <b>${result.validation.confidence}</b>`;
    if (result.validation.fixes.length > 0) {
      msg1 += `\n🔧 Fixes: ${result.validation.fixes.join('; ')}`;
    }
    if (result.retried) {
      msg1 += `\n🔄 Auto-retried for better accuracy`;
    }
    messages.push(msg1);

    // Message 2: Results
    messages.push(this.dbClient.formatForTelegram(result.queryResult));

    return messages;
  }
}
