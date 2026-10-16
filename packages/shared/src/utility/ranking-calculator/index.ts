export function calculateDownloadRank(rowIndex: number): number {
  return rowIndex + 1;
}

export function resolveKeywordColumn(fieldNames: string[]): string | undefined {
  if (fieldNames.includes("search_keyword")) return "search_keyword";
  if (fieldNames.includes("keyword")) return "keyword";
  return undefined;
}

function shouldResetByPartition(params: {
  currentKeyword?: string;
  previousKeyword?: string;
  currentRegion?: string;
  previousRegion?: string;
}): boolean {
  const keywordChanged =
    params.currentKeyword !== undefined && params.currentKeyword !== params.previousKeyword;
  const regionChanged =
    params.currentRegion !== undefined && params.currentRegion !== params.previousRegion;
  return keywordChanged || regionChanged;
}

export function calculateAdsRanking(params: {
  isAd: boolean;
  adsCounter: number;
  currentKeyword?: string;
  previousKeyword?: string;
  currentRegion?: string;
  previousRegion?: string;
}): {
  value: number;
  nextAdsCounter: number;
} {
  // Reset counter when keyword/region partition changes.
  let counter = params.adsCounter;
  if (shouldResetByPartition(params)) {
    counter = 0;
  }

  if (!params.isAd) {
    return {
      value: 0,
      nextAdsCounter: counter,
    };
  }

  const nextAdsCounter = counter + 1;
  return {
    value: nextAdsCounter,
    nextAdsCounter,
  };
}

export function calculateOrganicRanking(params: {
  isAd: boolean;
  organicCounter: number;
  currentKeyword?: string;
  previousKeyword?: string;
  currentRegion?: string;
  previousRegion?: string;
}): {
  value: number;
  nextOrganicCounter: number;
} {
  // Reset counter when keyword/region partition changes.
  let counter = params.organicCounter;
  if (shouldResetByPartition(params)) {
    counter = 0;
  }

  if (params.isAd) {
    return {
      value: counter,
      nextOrganicCounter: counter,
    };
  }

  const nextOrganicCounter = counter + 1;
  return {
    value: nextOrganicCounter,
    nextOrganicCounter,
  };
}

export function calculateOverallRanking(params: {
  overallCounter: number;
  currentKeyword?: string;
  previousKeyword?: string;
  currentRegion?: string;
  previousRegion?: string;
}): {
  value: number;
  nextOverallCounter: number;
} {
  // Reset counter when keyword/region partition changes.
  let counter = params.overallCounter;
  if (shouldResetByPartition(params)) {
    counter = 0;
  }

  const nextOverallCounter = counter + 1;
  return {
    value: nextOverallCounter,
    nextOverallCounter,
  };
}
