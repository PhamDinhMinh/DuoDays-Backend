import { vi } from 'vitest';

/*
 * Write-boundary barriers for deterministic race tests. Both wrap a real service method:
 * the real database write always happens – nothing is mocked away – and only the timing
 * around it is controlled.
 */

type AsyncMethod = (...args: unknown[]) => Promise<unknown>;

function wrap<T extends object>(
  target: T,
  method: keyof T & string,
  around: (real: () => Promise<unknown>) => Promise<unknown>,
): void {
  const real = (target[method] as AsyncMethod).bind(target);
  vi.spyOn(target as unknown as Record<string, AsyncMethod>, method).mockImplementation(
    (...args: unknown[]) => around(() => real(...args)),
  );
}

export interface Pause {
  /** Resolves once the first call's real write has completed (inside its transaction). */
  reached: Promise<void>;
  /** Lets the paused call return, so its transaction continues and commits. */
  release: () => void;
}

/**
 * Holds the FIRST call of `target[method]` after its real write, i.e. keeps that
 * transaction open with its writes in place but uncommitted. Later calls pass through.
 */
export function pauseAfterFirstCall<T extends object>(target: T, method: keyof T & string): Pause {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>(resolve => (reached = resolve));
  const released = new Promise<void>(resolve => (release = resolve));
  let first = true;
  wrap(target, method, async real => {
    const result = await real();
    if (first) {
      first = false;
      reached();
      await released;
    }
    return result;
  });
  return { reached: reachedP, release };
}

export interface ConflictWatch {
  /** Resolves on the first call that MongoDB rejects with a transient write conflict. */
  conflicted: Promise<void>;
  /** Settled calls so far: `true`/`false` results of conditional writes, or 'conflict'. */
  outcomes: unknown[];
}

/**
 * Records every call of `target[method]`. A rejection labelled TransientTransactionError
 * means the write ran into another transaction's uncommitted write on the same document –
 * MongoDB is serialising the two; the driver then retries the whole callback.
 */
export function watchConflicts<T extends object>(
  target: T,
  method: keyof T & string,
): ConflictWatch {
  let conflicted!: () => void;
  const conflictedP = new Promise<void>(resolve => (conflicted = resolve));
  const outcomes: unknown[] = [];
  wrap(target, method, async real => {
    try {
      const result = await real();
      outcomes.push(result);
      return result;
    } catch (error) {
      if (isTransient(error)) {
        outcomes.push('conflict');
        conflicted();
      }
      throw error;
    }
  });
  return { conflicted: conflictedP, outcomes };
}

function isTransient(error: unknown): boolean {
  const { hasErrorLabel } = (error ?? {}) as { hasErrorLabel?: (label: string) => boolean };
  return (
    typeof hasErrorLabel === 'function' && hasErrorLabel.call(error, 'TransientTransactionError')
  );
}

/** Sends a supertest request now (supertest only sends once awaited/then-ed). */
export function send<T>(test: PromiseLike<T>): Promise<T> {
  return Promise.resolve(test);
}
