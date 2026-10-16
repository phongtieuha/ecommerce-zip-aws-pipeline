export function sortWithReferenceOrder(
  values: ReadonlyArray<string>,
  order: ReadonlyArray<string>,
): string[] {
  const orderMap = new Map(order.map((value, index) => [value, index]));

  return [...values].sort((a, b) => {
    const aOrder = orderMap.get(a);
    const bOrder = orderMap.get(b);

    if (aOrder !== undefined && bOrder !== undefined) {
      return aOrder - bOrder;
    }
    if (aOrder !== undefined) {
      return -1;
    }
    if (bOrder !== undefined) {
      return 1;
    }

    return a.localeCompare(b);
  });
}
