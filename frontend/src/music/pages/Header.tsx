import type { ReactNode } from 'react';

/** Album / playlist header: big artwork, title, two lines of facts, actions. */
export function CollectionHeader({
  art,
  title,
  meta,
  facts,
  description,
  actions,
}: {
  art: ReactNode;
  title: string;
  meta: ReactNode;
  facts: ReactNode;
  description?: string | null;
  actions: ReactNode;
}) {
  return (
    <header className="flex flex-col items-center gap-6 pt-8 pb-8 text-center md:flex-row md:items-end md:gap-8 md:text-left">
      <div className="w-[min(264px,70vw)] shrink-0 shadow-[0_8px_40px_rgb(0_0_0/0.5)]">{art}</div>
      <div className="min-w-0 flex-1">
        <h1 className="text-[clamp(1.8rem,3.4vw,2.8rem)] leading-tight font-bold break-words">{title}</h1>
        <p className="mt-3 text-[15px] text-white/70">{meta}</p>
        <p className="mt-1 text-[15px] text-white/70">{facts}</p>
        {description && <p className="mt-3 line-clamp-3 max-w-2xl text-sm whitespace-pre-line text-white/60">{description}</p>}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3 md:justify-start">{actions}</div>
      </div>
    </header>
  );
}
