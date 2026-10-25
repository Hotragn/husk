/**
 * Host matching for the husk's NetworkPolicy: core's, the one answer.
 *
 * This was a second copy, kept "on purpose" and "tested so the two agree".
 * They did not: this one let the metadata endpoint through as an IPv6-mapped
 * address after core had learned to refuse it. A security check with two
 * answers is not a security check, so the agent's tools use core's directly.
 * `isPrivateHost` keeps its name for anyone importing it from this package.
 */
export { assertUrlAllowed, hostMatches, isHostAllowed, isInternalHost as isPrivateHost, urlHost } from '@husk-ai/core';
