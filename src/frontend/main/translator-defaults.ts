/** Built-in history hint body (without the leading space prepended in the system prompt). */
export const BUILTIN_HISTORY_SYSTEM_HINT_BODY =
  'Use the conversation history of previous subtitles to maintain terminology consistency and correct possible speech-recognition errors.';

/** Full fragment appended to the system prompt (includes leading space). */
export const DEFAULT_HISTORY_SYSTEM_HINT = ` ${BUILTIN_HISTORY_SYSTEM_HINT_BODY}`;
