import type { DistilledAgent, Transcript } from '@husk/core';
import { distillHeuristic, distillWithModel } from './distill.js';
import type { ModelDistillOptions } from './distill.js';
import type { ChatLike } from './chat.js';

/**
 * The old single-class entry point, kept working.
 *
 * New code should call `distillHeuristic` or `distillWithModel` directly: the
 * two paths behave differently enough -- one is free and offline, the other
 * spends tokens -- that hiding the choice behind a constructor argument was the
 * wrong shape.
 */
export class Distiller {
  constructor(
    private readonly provider?: ChatLike,
    private readonly opts: ModelDistillOptions = {},
  ) {}

  async distill(transcript: Transcript): Promise<DistilledAgent> {
    if (!this.provider) return distillHeuristic(transcript, this.opts);
    return distillWithModel(transcript, this.provider, this.opts);
  }
}
