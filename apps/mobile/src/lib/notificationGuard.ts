export interface NotificationTicket {
  epoch: number;
  generation: number;
  key: string;
}

/** Invalidates notification work that completes after its owning state has changed. */
export class NotificationGenerationGuard {
  private epoch = 0;
  private readonly generations = new Map<string, number>();

  begin(key: string): NotificationTicket {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    return { epoch: this.epoch, generation, key };
  }

  invalidate(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  reset(): void {
    this.epoch += 1;
    this.generations.clear();
  }

  isCurrent(ticket: NotificationTicket): boolean {
    return ticket.epoch === this.epoch && this.generations.get(ticket.key) === ticket.generation;
  }
}

/** Serializes schedule/cancel operations that target the same deterministic Android ID. */
export class NotificationOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

export async function settleGuardedNotification(options: {
  guard: NotificationGenerationGuard;
  ticket: NotificationTicket;
  queue: NotificationOperationQueue;
  operationKey: string;
  schedule: () => Promise<boolean>;
  isRelevant: () => boolean;
  cancel: () => Promise<void>;
}): Promise<'shown' | 'failed' | 'stale'> {
  return options.queue.run(options.operationKey, async () => {
    const shown = await options.schedule();
    if (!options.guard.isCurrent(options.ticket) || !options.isRelevant()) {
      if (shown) await options.cancel();
      return 'stale';
    }
    return shown ? 'shown' : 'failed';
  });
}
