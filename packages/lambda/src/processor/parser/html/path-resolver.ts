import { load, type CheerioAPI } from "cheerio";
import { applyOperation, parseOperation } from "../../schema/operation/index.js";

const htmlDocumentCache = new WeakMap<Record<string, unknown>, CheerioAPI>();

type HtmlExpressionAccessor =
  | { type: "default" }
  | { type: "text" }
  | { type: "html" }
  | { type: "outerHtml" }
  | { type: "length" }
  | { type: "attribute"; name: string };

type HtmlExpressionQueryType = "querySelector" | "querySelectorAll";

function parseDocumentQuerySelectorExpression(expression: string):
  | {
      queryType: HtmlExpressionQueryType;
      selector: string;
      accessor: HtmlExpressionAccessor;
    }
  | undefined {
  const trimmed = expression.trim();
  const queryMatch = trimmed.match(
    /^document\.(querySelector|querySelectorAll)\(\s*(['"])([\s\S]*?)\2\s*\)([\s\S]*)$/,
  );

  if (!queryMatch) {
    return undefined;
  }

  const queryType = queryMatch[1] as HtmlExpressionQueryType;
  const selector = queryMatch[3].trim();
  const remainder = queryMatch[4].trim();

  if (!selector) {
    return undefined;
  }

  if (!remainder) {
    return { queryType, selector, accessor: { type: "default" } };
  }

  if (remainder === ".length") {
    return { queryType, selector, accessor: { type: "length" } };
  }

  if (remainder === ".innerText" || remainder === ".textContent") {
    return { queryType, selector, accessor: { type: "text" } };
  }

  if (remainder === ".innerHTML") {
    return { queryType, selector, accessor: { type: "html" } };
  }

  if (remainder === ".outerHTML") {
    return { queryType, selector, accessor: { type: "outerHtml" } };
  }

  const attrMatch = remainder.match(/^\.getAttribute\(\s*(['"])([^'"]+)\1\s*\)$/);
  if (attrMatch) {
    return {
      queryType,
      selector,
      accessor: { type: "attribute", name: attrMatch[2] },
    };
  }

  return undefined;
}

function getCachedHtmlDocument(obj: Record<string, unknown>): CheerioAPI | undefined {
  const cached = htmlDocumentCache.get(obj);
  if (cached) {
    return cached;
  }

  const htmlCandidate = obj.__html ?? obj.html;
  if (typeof htmlCandidate !== "string" || htmlCandidate.trim().length === 0) {
    return undefined;
  }

  const $ = load(htmlCandidate);
  htmlDocumentCache.set(obj, $);
  return $;
}

function extractElementValue(
  $: CheerioAPI,
  element: ReturnType<CheerioAPI>,
  accessor: HtmlExpressionAccessor,
): unknown {
  switch (accessor.type) {
    case "text": {
      const text = element.text().trim();
      return text.length > 0 ? text : undefined;
    }

    case "html": {
      const html = element.html()?.trim();
      return html && html.length > 0 ? html : undefined;
    }

    case "outerHtml": {
      const outerHtml = $.html(element).trim();
      return outerHtml.length > 0 ? outerHtml : undefined;
    }

    case "attribute": {
      return element.attr(accessor.name)?.trim();
    }

    case "default": {
      const text = element.text().trim();
      if (text.length > 0) {
        return text;
      }

      const attr =
        element.attr("content") ??
        element.attr("value") ??
        element.attr("href") ??
        element.attr("src");

      return attr?.trim();
    }

    case "length": {
      return undefined;
    }
  }
}

export function resolveHtmlSelectorValue(
  obj: Record<string, unknown>,
  selector: string,
  parsedExpression?: {
    queryType: HtmlExpressionQueryType;
    selector: string;
    accessor: HtmlExpressionAccessor;
  },
): unknown {
  const expression = parsedExpression ?? parseDocumentQuerySelectorExpression(selector);
  if (!expression) {
    return undefined;
  }

  const $ = getCachedHtmlDocument(obj);
  if (!$) {
    return undefined;
  }

  try {
    const collection = $(expression.selector);
    if (collection.length === 0) {
      return undefined;
    }

    if (expression.accessor.type === "length") {
      return collection.length;
    }

    if (expression.queryType === "querySelectorAll") {
      const values: unknown[] = [];
      collection.each((_, el) => {
        const value = extractElementValue($, $(el), expression.accessor);
        if (value !== undefined && value !== null) {
          values.push(value);
        }
      });
      return values;
    }

    return extractElementValue($, collection.first(), expression.accessor);
  } catch {
    return undefined;
  }
}

export function getHtmlNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const fallbackPaths = path
    .split("||")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (fallbackPaths.length > 1) {
    for (const fallbackPath of fallbackPaths) {
      const resolved = getHtmlNestedValue(obj, fallbackPath);
      if (resolved !== undefined && resolved !== null) {
        if (typeof resolved !== "string" || resolved.trim().length > 0) {
          return resolved;
        }
      }
    }

    return undefined;
  }

  const { basePath, operation, operations } = parseOperation(path);
  const expression = parseDocumentQuerySelectorExpression(basePath);
  if (!expression) {
    return undefined;
  }

  const current = resolveHtmlSelectorValue(obj, basePath, expression);

  if (operations && operations.length > 0) {
    let transformed: unknown = current;
    for (const op of operations) {
      transformed = applyOperation(transformed, op, obj);
      if (transformed === undefined) {
        return undefined;
      }
    }
    return transformed;
  }

  if (operation) {
    return applyOperation(current, operation, obj);
  }

  return current;
}
