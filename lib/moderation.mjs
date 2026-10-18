// ARGUS uses the standalone writing moderator in ai-moderator-plugin/ with its own MiniMax client.
import path from 'node:path';
import { env } from './config.mjs';
import { minimax } from './providers.mjs';
import { createModerator } from '../ai-moderator-plugin/src/index.mjs';
export { inspectDraft } from '../ai-moderator-plugin/src/index.mjs';
// ARGUS_MODERATOR_ROOT can point at the team's full AI Moderator project to use its latest prompts.
export const moderator = createModerator({ call: minimax, ...(env.ARGUS_MODERATOR_ROOT ? { promptsFile: path.join(env.ARGUS_MODERATOR_ROOT, 'lib/moderation/prompts.ts') } : {}) });
export const moderate = moderator.moderate;
