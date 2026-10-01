import { MongoMemoryReplSet } from 'mongodb-memory-server';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection string of the throwaway single-node replica set. */
    mongoUri: string;
  }
}

/**
 * Starts one in-memory MongoDB replica set for the whole e2e run (transactions need a
 * replica set). Each test app uses its own database on it, dropped on close.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await replSet.waitUntilRunning();
  project.provide('mongoUri', replSet.getUri());

  return async () => {
    await replSet.stop();
  };
}
