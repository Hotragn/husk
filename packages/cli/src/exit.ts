/**
 * Exit codes are an API. Scripts and CI key off these, so they are frozen.
 *
 * `husk exec` is the one deliberate exception: it exits with the child's code,
 * because a wrapper that swallowed it would be useless in a pipeline. Its help
 * text says so.
 */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_SIGINT = 130;
