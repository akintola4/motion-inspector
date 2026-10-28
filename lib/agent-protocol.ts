/** Shared between the page agent and the panel bridge. */

export const AGENT_VERSION = 1;
export const AGENT_GLOBAL = '__motionInspector';

export type AgentMethod =
  | 'snapshot'
  | 'pause'
  | 'play'
  | 'scrub'
  | 'scrubOne'
  | 'setRate'
  | 'restart'
  | 'select'
  | 'reset'
  | 'probe'
  | 'dispose';
