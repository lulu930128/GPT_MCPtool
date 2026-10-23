/** Attempt every owned cleanup, in order, without hiding an earlier failure. */
export async function closeResources(steps: Array<() => void | Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "RESOURCE_CLOSE_FAILED");
}

/** Bounds observation, not the operation. A timeout is UNKNOWN; never cancel,
 * retry, force exit, or report successful cleanup while the operation continues. */
export async function waitForClose<T>(operation: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
