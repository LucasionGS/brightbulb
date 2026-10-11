import type { LucideIcon } from "lucide-react";
import "./EmptyState.scss";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  busy?: boolean;
}

export default function EmptyState(props: EmptyStateProps) {
  const { icon: Icon, title, description, children, busy = false } = props;
  return (
    <div className="bb-empty">
      <div className={`bb-empty__icon${busy ? " bb-empty__icon--busy" : ""}`}>
        <Icon size={30} />
      </div>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {children && <div className="bb-empty__actions">{children}</div>}
    </div>
  );
}
