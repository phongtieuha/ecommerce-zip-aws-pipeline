type SectionNoticeTone = "muted" | "destructive";

type SectionNoticeProps = {
  message: string;
  tone?: SectionNoticeTone;
};

export function SectionNotice({ message, tone = "muted" }: SectionNoticeProps) {
  const toneClassName =
    tone === "destructive"
      ? "border-destructive/50 bg-destructive/10 text-destructive"
      : "border-border bg-card text-muted-foreground";

  return <div className={`rounded-md border px-4 py-3 text-sm ${toneClassName}`}>{message}</div>;
}
