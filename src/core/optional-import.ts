// ─── Optional dependencies ──────────────────────────────────────────────────
//
// playwright and unpdf are optional. The module name is passed through a Function so bundlers that trace
// imports do not try to include them, and a missing module returns null.

export async function optionalImport<T>(name: string): Promise<T | null> {
  try {
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<T>;
    return await dynamicImport(name);
  } catch {
    return null;
  }
}
