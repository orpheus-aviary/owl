import type { ToolDef } from '../tool-registry.js';

export const getCapabilitiesTool: ToolDef = {
  name: 'get_capabilities',
  description:
    'Return the list of tools this agent can call (name + description). Useful when the agent ' +
    'needs to remind itself of its own toolbox before planning a multi-step action.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    if (!ctx.registry) {
      return { tools: [], note: 'registry not attached to context' };
    }
    return {
      tools: ctx.registry.all().map((t) => ({ name: t.name, description: t.description })),
    };
  },
};
