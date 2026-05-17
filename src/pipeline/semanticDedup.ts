/**
 * Layer 2 — AI Semantic Deduplication.
 * After a job passes AI curation (STRONG_MATCH), compares it against previously
 * stored jobs from the same company to detect reposts.
 * Scoped to same-company only to avoid false positives.
 */

import OpenAI from 'openai';
import { getDb, type JobRow } from '../db';
import type { ScoredJob } from './aiScorer';
import type { SettingsRow } from '../db';

const MAX_COMPANY_JOBS = 20;
const DESCRIPTION_TRUNCATE = 2_000;
const TOKEN_THRESHOLD = 12_000; // Approximate char count (~4 chars/token)

export interface DedupResult {
  scoredJob: ScoredJob;
  isDuplicate: boolean;
  duplicateOfId: number | null;
  reasoning: string;
}

interface DedupLlmOutput {
  is_duplicate: boolean;
  duplicate_of_id: number | null;
  reasoning: string;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildDedupPrompt(newJob: ScoredJob, existingJobs: JobRow[]): string {
  let existingSection = '';
  let totalTokens = estimateTokens(newJob.job.description);

  for (const existing of existingJobs) {
    const desc =
      totalTokens > TOKEN_THRESHOLD
        ? existing.description.substring(0, DESCRIPTION_TRUNCATE)
        : existing.description;
    totalTokens += estimateTokens(desc);

    existingSection += `Job ID: ${existing.id} | Title: ${existing.title}\nDescription: ${desc}\n---\n`;
  }

  return `=== NEW JOB ===
Title: ${newJob.job.title}
Description: ${newJob.job.description}

=== EXISTING CURATED JOBS FROM ${newJob.job.company} ===
${existingSection}
Respond ONLY with JSON: { "is_duplicate": bool, "duplicate_of_id": number|null, "reasoning": "..." }`;
}

async function runDedupLlm(
  prompt: string,
  model: string,
  systemPrompt: string,
  openAiKey: string,
): Promise<DedupLlmOutput> {
  const client = new OpenAI({ apiKey: openAiKey });
  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_output_tokens: 150,
    text: {
      format: {
        type: 'json_schema',
        name: 'dedup_result',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            is_duplicate: { type: 'boolean' },
            duplicate_of_id: { type: ['integer', 'null'] },
            reasoning: { type: 'string' },
          },
          required: ['is_duplicate', 'duplicate_of_id', 'reasoning'],
        },
      },
    },
  });

  const text = response.output_text;
  if (!text) throw new Error('Empty dedup response from OpenAI');
  return JSON.parse(text) as DedupLlmOutput;
}

export async function checkDuplicate(
  scoredJob: ScoredJob,
  settings: SettingsRow,
  openAiKey: string,
): Promise<DedupResult> {
  const db = getDb();

  // Query existing non-duplicate curated jobs from same company
  const existing = db
    .prepare(
      `SELECT j.id, j.title, COALESCE(jd.description_text, j.description) AS description
       FROM jobs j
       JOIN job_profile_states jps ON jps.job_id = j.id
       LEFT JOIN job_descriptions jd ON jd.job_id = j.id
       WHERE j.company = ? AND jps.is_duplicate = 0
       ORDER BY jps.fetched_at DESC
       LIMIT ?`,
    )
    .all(scoredJob.job.company, MAX_COMPANY_JOBS) as JobRow[];

  // If no prior jobs from this company, it's definitely new
  if (existing.length === 0) {
    return {
      scoredJob,
      isDuplicate: false,
      duplicateOfId: null,
      reasoning: 'No existing jobs from this company to compare against.',
    };
  }

  const prompt = buildDedupPrompt(scoredJob, existing);

  let output: DedupLlmOutput;
  try {
    output = await runDedupLlm(prompt, settings.ai_model, settings.dedup_system_prompt, openAiKey);
  } catch (err) {
    console.error(
      `[semanticDedup] Dedup check failed for "${scoredJob.job.title}" at "${scoredJob.job.company}":`,
      (err as Error).message,
    );
    // On LLM failure, treat as non-duplicate to avoid losing real jobs
    return {
      scoredJob,
      isDuplicate: false,
      duplicateOfId: null,
      reasoning: 'Dedup check failed; treated as new job.',
    };
  }

  return {
    scoredJob,
    isDuplicate: output.is_duplicate,
    duplicateOfId: output.duplicate_of_id,
    reasoning: output.reasoning,
  };
}
