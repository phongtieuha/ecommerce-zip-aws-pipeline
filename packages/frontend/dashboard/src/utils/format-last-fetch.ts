export function formatLastFetch(isoTimestamp: string | null): string {
  if (!isoTimestamp) {
    return "Updated: --";
  }

  const timestamp = new Date(isoTimestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return "Updated: --";
  }

  const now = new Date();
  const isToday =
    timestamp.getFullYear() === now.getFullYear() &&
    timestamp.getMonth() === now.getMonth() &&
    timestamp.getDate() === now.getDate();

  const timeLabel = timestamp.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  if (isToday) {
    return `Updated at ${timeLabel}`;
  }

  const dateLabel = timestamp.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  return `Updated ${dateLabel} at ${timeLabel}`;
}
