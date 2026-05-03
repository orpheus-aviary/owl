import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { paths } from '@owl/core';
import { CliError } from '../lib/errors.js';
import type { OutputStreams } from '../lib/output.js';
import { writeRaw, writeResult } from '../lib/output.js';
import { renderOwlSkillTemplate } from './skill-template.js';

export interface SkillExportFlags {
  output?: string;
  json?: boolean;
  human?: boolean;
  pretty?: boolean;
}

export interface SkillExportResult {
  path: string;
  prompt: string;
}

/** Default basename; used both when `--output` is a directory and when unset. */
const DEFAULT_BASENAME = 'owl-skill.md';

/**
 * Resolve the final output path from a user-supplied `--output`. Accepts
 * absolute or relative paths; relative resolves against cwd (matching shell
 * intuition, not paths.owlDir()). If the path is an existing directory, the
 * default basename is appended.
 */
function resolveOutputPath(output: string | undefined): string {
  if (!output) return join(paths.owlDir(), DEFAULT_BASENAME);
  const abs = isAbsolute(output) ? output : resolve(process.cwd(), output);
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    return join(abs, DEFAULT_BASENAME);
  }
  return abs;
}

function buildInstallPrompt(filePath: string): string {
  return `请读取 ${filePath}，把它作为一个 skill 安装到当前 AI agent 的全局 skill 目录（如果不确定全局路径，就装到当前项目级目录）。请按照当前 agent 的 skill 规范调整前置元数据（例如 Claude Code 的 YAML frontmatter、Cursor 的 .mdc globs），然后告诉我最终装到了哪里、以及如何验证触发正常。`;
}

function buildHumanOutput(filePath: string, prompt: string): string {
  const divider = '─'.repeat(60);
  return [
    '✓ owl skill 已导出到:',
    `  ${filePath}`,
    '',
    '下一步：把下面这段提示词完整粘贴给你正在使用的 AI 助手',
    '（Claude Code / Cursor / Cline / 其他），由它根据你当前 agent',
    '的 skill 规范把文件安装到全局或项目级 skill 目录：',
    '',
    divider,
    prompt,
    divider,
    '',
  ].join('\n');
}

/**
 * Write the skill markdown and emit either a human-readable summary or
 * a flat JSON `{ path, prompt }`. This command is the one intentional
 * exception to owl CLI's JSON-first default — see §3.2 in the P3.2.5
 * design doc for the rationale.
 *
 * Flag precedence (caller-validated to exclude `--json --human`):
 *   `json === true`  → JSON mode
 *   otherwise        → human mode (default, and explicit `--human`)
 */
export async function runSkillExport(
  flags: SkillExportFlags,
  deps: { streams: OutputStreams; version: string },
): Promise<SkillExportResult> {
  if (flags.json === true && flags.human === true) {
    throw new CliError('USAGE_ERROR', '--json and --human are mutually exclusive');
  }

  const outputPath = resolveOutputPath(flags.output);
  await mkdir(dirname(outputPath), { recursive: true });
  const content = renderOwlSkillTemplate({ version: deps.version });
  await writeFile(outputPath, content, 'utf8');

  const prompt = buildInstallPrompt(outputPath);

  if (flags.json === true) {
    writeResult({ path: outputPath, prompt } satisfies SkillExportResult, {
      pretty: flags.pretty,
      streams: deps.streams,
    });
  } else {
    writeRaw(buildHumanOutput(outputPath, prompt), { streams: deps.streams });
  }

  return { path: outputPath, prompt };
}
