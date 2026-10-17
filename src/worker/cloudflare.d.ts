// Minimal typings for the Cloudflare runtime pieces used by src/worker (avoids pulling workers-types into the Node build).
declare module 'cloudflare:workers' {
  export interface DurableObjectState {
    storage: {
      sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };
      transactionSync<T>(fn: () => T): T;
      setAlarm(time: number): Promise<void>;
    };
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  }
  export class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
declare module '*.otf' {
  const data: ArrayBuffer;
  export default data;
}
declare module '*.png' {
  const data: ArrayBuffer;
  export default data;
}
