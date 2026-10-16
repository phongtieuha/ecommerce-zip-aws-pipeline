import { createContext, runInContext } from "node:vm";

/**
 * Extract JSON data from HTML by executing inline <script> contents in a
 * sandboxed VM, then evaluating a JS expression against the resulting context.
 *
 * @param html - Raw HTML string containing <script> tags
 * @param expression - JS expression to evaluate (e.g.
 *   "window.dataLayer.filter(x => x['ecommerce']).flatMap(x => x.ecommerce.impressions)")
 * @returns Array of plain objects extracted by the expression, or empty array
 */
export function extractFromScripts(
  html: string,
  expression: string,
  onError?: (message: string) => void,
): Array<Record<string, unknown>> {
  // 1. Pull all inline <script> blocks from the HTML
  const scriptContents = extractScriptContents(html);

  if (scriptContents.length === 0) {
    return [];
  }

  // 2. Build a minimal sandbox with window/document stubs
  const { sandbox } = createSandbox(html);
  const ctx = createContext(sandbox);

  // 3. Execute each script block to populate variables (dataLayer, etc.)
  for (const script of scriptContents) {
    try {
      runInContext(script, ctx, { timeout: 5000 });
    } catch {
      // Ignore individual script failures — many scripts reference browser
      // APIs (require, matchMedia, etc.) that don't exist in our sandbox.
    }
  }

  // 3b. Fire all registered event listeners (e.g. "shopLoaded") so that
  //     deferred functions like pushImpressions() execute and populate dataLayer.
  //     We dispatch a synthetic event via the VM context itself so callbacks
  //     can access in-scope variables (like _impr_list).
  try {
    runInContext(
      `
      if (typeof window !== 'undefined' && window.__pendingEvents) {
        for (const listeners of Object.values(window.__pendingEvents)) {
          for (const fn of listeners) {
            try { fn(); } catch(e) {}
          }
        }
      }
      `,
      ctx,
      { timeout: 5000 },
    );
  } catch {
    // Ignore — listener execution is best-effort
  }

  // 4. Evaluate the extraction expression
  let result: unknown;
  try {
    result = runInContext(expression, ctx, { timeout: 5000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (onError) {
      onError(message);
    } else {
      console.warn(`scriptExpression evaluation failed: ${message}`);
    }
    return [];
  }

  // 5. Normalise into an array of objects
  if (result === null || result === undefined) {
    return [];
  }

  if (Array.isArray(result)) {
    return result.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    );
  }

  if (typeof result === "object" && !Array.isArray(result)) {
    return [result as Record<string, unknown>];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractScriptContents(html: string): string[] {
  const scripts: string[] = [];
  const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const content = match[1].trim();
    if (content.length > 0) {
      scripts.push(content);
    }
  }

  return scripts;
}

function createSandbox(rawHtml: string): {
  sandbox: Record<string, unknown>;
} {
  // Minimal stubs that 711 (and similar) inline scripts expect.
  // __pendingEvents stores event listeners registered via addEventListener
  // so we can fire them from the VM context after all scripts are loaded.
  const pendingEvents: Record<string, unknown[]> = {};

  const window: Record<string, unknown> = {
    dataLayer: [],
    __html: rawHtml,
    __pendingEvents: pendingEvents,
    location: { href: "", search: "", pathname: "/" },
    matchMedia: () => ({ matches: false }),
    addEventListener: (event: string, fn: unknown) => {
      (pendingEvents[event] ??= []).push(fn);
    },
    removeEventListener: () => {},
    XMLHttpRequest: class {},
  };

  const document: Record<string, unknown> = {
    cookie: "",
    documentElement: { className: "" },
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    createElement: () => ({
      async: false,
      src: "",
      parentNode: { insertBefore: () => {} },
    }),
    location: window.location,
  };

  // Many scripts reference globals without `window.` prefix
  const sandbox = {
    window,
    document,
    __html: rawHtml,
    rawHtml,
    dataLayer: window.dataLayer,
    location: window.location,
    navigator: { userAgent: "" },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    encodeURIComponent,
    decodeURIComponent,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };

  return { sandbox };
}
