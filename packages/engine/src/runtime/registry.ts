/** Template registry: one factory per visual type. */
import type { ResolvedVisual } from '../core/render-plan.ts';
import { architectureTemplate } from './templates/architecture.ts';
import { beforeAfterTemplate } from './templates/before-after.ts';
import { browserTemplate } from './templates/browser.ts';
import { bulletsTemplate } from './templates/bullets.ts';
import { checklistTemplate } from './templates/checklist.ts';
import { codeTemplate } from './templates/code.ts';
import { filesTemplate } from './templates/files.ts';
import { flowTemplate } from './templates/flow.ts';
import { missionTemplate } from './templates/mission.ts';
import { screenshotTemplate } from './templates/screenshot.ts';
import { summaryTemplate } from './templates/summary.ts';
import { terminalTemplate } from './templates/terminal.ts';
import { titleTemplate } from './templates/title.ts';
import type { TemplateFactory } from './types.ts';

type Registry = { [K in ResolvedVisual['type']]: TemplateFactory<Extract<ResolvedVisual, { type: K }>> };

export const TEMPLATES: Registry = {
  title: titleTemplate,
  mission: missionTemplate,
  files: filesTemplate,
  architecture: architectureTemplate,
  flow: flowTemplate,
  code: codeTemplate,
  'before-after': beforeAfterTemplate,
  terminal: terminalTemplate,
  browser: browserTemplate,
  checklist: checklistTemplate,
  bullets: bulletsTemplate,
  screenshot: screenshotTemplate,
  summary: summaryTemplate,
};

export function templateFor(visual: ResolvedVisual): TemplateFactory {
  return TEMPLATES[visual.type] as TemplateFactory;
}
