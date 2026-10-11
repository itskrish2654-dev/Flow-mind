import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, children }: {
  eyebrow: string; title: string; description: string; children?: ReactNode;
}) {
  return <header className="work-page-header">
    <div><p className="work-eyebrow">{eyebrow}</p><h1>{title}</h1><p className="work-description">{description}</p></div>
    {children && <div className="work-header-actions">{children}</div>}
  </header>;
}
