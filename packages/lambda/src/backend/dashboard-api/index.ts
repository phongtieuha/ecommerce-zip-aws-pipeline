import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { handleGetDataValidationReport } from "./get-data-validation-report";
import { handleGetProductIds } from "./get-product-ids";
import { handleGetProductIdsReport } from "./get-product-ids-report";
import { handleGetShopIds } from "./get-shop-ids";
import { handleGetShopIdsReport } from "./get-shop-ids-report";
import {
  handleGetFeature1Metrics,
  handleGetFeature2Metrics,
  handleGetMetrics,
} from "./get-metrics";
import {
  handleGetFeature1ZipFilesIngestedTotal,
  handleGetFeature2ZipFilesIngestedTotal,
} from "./get-volume-trend-for-zipFilesIngestedTotal";
import {
  handleGetFeature1JsonHtmlFilesIngested,
  handleGetFeature2JsonHtmlFilesIngested,
} from "./get-volume-trend-for-jsonHtmlFilesIngested";
import {
  handleGetFeature1UniqueProductsIngestedTotal,
  handleGetFeature2UniqueProductsIngestedTotal,
} from "./get-volume-trend-for-uniqueProductsIngestedTotal";
import {
  handleGetFeature1UniqueProductsInOutputTotalTotal,
  handleGetFeature2UniqueProductsInOutputTotalTotal,
} from "./get-volume-trend-for-uniqueProductsInOutputTotalTotal";

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function normalizePath(path?: string): string {
  if (!path) return "/";
  return path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = normalizePath(event.rawPath);

  if (method !== "GET") {
    return jsonResponse(405, {
      error:
        "Method not allowed. Use GET /metrics, /feature1/metrics, /feature2/metrics, /feature1/zipFilesIngestedTotal, /feature2/zipFilesIngestedTotal, /feature1/jsonHtmlFilesIngested, /feature2/jsonHtmlFilesIngested, /feature1/uniqueProductsIngestedTotal, /feature2/uniqueProductsIngestedTotal, /feature1/uniqueProductsInOutputTotalTotal, /feature2/uniqueProductsInOutputTotalTotal, /get-data-validation-report?date=YYYY-MM-DD, /get-product-ids?date=YYYY-MM-DD&feature=feature1&section[]=...&platform[]=..., /get-product-ids-report?date=YYYY-MM-DD, /get-shop-ids?date=YYYY-MM-DD&feature=feature1&section[]=...&platform[]=..., or /get-shop-ids-report?date=YYYY-MM-DD.",
    });
  }

  if (path === "/metrics") {
    return handleGetMetrics(event);
  }

  if (path === "/feature1/metrics") {
    return handleGetFeature1Metrics(event);
  }

  if (path === "/feature2/metrics") {
    return handleGetFeature2Metrics(event);
  }

  if (path === "/feature1/zipFilesIngestedTotal") {
    return handleGetFeature1ZipFilesIngestedTotal(event);
  }

  if (path === "/feature2/zipFilesIngestedTotal") {
    return handleGetFeature2ZipFilesIngestedTotal(event);
  }

  if (path === "/feature1/jsonHtmlFilesIngested") {
    return handleGetFeature1JsonHtmlFilesIngested(event);
  }

  if (path === "/feature2/jsonHtmlFilesIngested") {
    return handleGetFeature2JsonHtmlFilesIngested(event);
  }

  if (path === "/feature1/uniqueProductsIngestedTotal") {
    return handleGetFeature1UniqueProductsIngestedTotal(event);
  }

  if (path === "/feature2/uniqueProductsIngestedTotal") {
    return handleGetFeature2UniqueProductsIngestedTotal(event);
  }

  if (path === "/feature1/uniqueProductsInOutputTotalTotal") {
    return handleGetFeature1UniqueProductsInOutputTotalTotal(event);
  }

  if (path === "/feature2/uniqueProductsInOutputTotalTotal") {
    return handleGetFeature2UniqueProductsInOutputTotalTotal(event);
  }

  if (path === "/get-data-validation-report") {
    return handleGetDataValidationReport(event);
  }

  if (path === "/get-product-ids") {
    return handleGetProductIds(event);
  }

  if (path === "/get-product-ids-report") {
    return handleGetProductIdsReport(event);
  }

  if (path === "/get-shop-ids") {
    return handleGetShopIds(event);
  }

  if (path === "/get-shop-ids-report") {
    return handleGetShopIdsReport(event);
  }

  return jsonResponse(404, { error: "Not found" });
}
