import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import "./Sheet.scss";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /**
   * Tint colour for the sheet's glow.
   */
  accent?: string;
  children: React.ReactNode;
}

/**
 * A centred modal panel, used for light details.
 */
export default function Sheet(props: SheetProps) {
  const { open, onClose, title, description, accent, children } = props;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="bb-sheet__backdrop" />
        <Dialog.Popup className="bb-sheet" style={accent ? { "--bb-sheet-accent": accent } as React.CSSProperties : undefined}>
          <header className="bb-sheet__header">
            <div>
              <Dialog.Title className="bb-sheet__title">{title}</Dialog.Title>
              {description && <Dialog.Description className="bb-sheet__description">{description}</Dialog.Description>}
            </div>
            <Dialog.Close className="bb-btn bb-btn--ghost bb-btn--icon" aria-label="Close">
              <X size={18} />
            </Dialog.Close>
          </header>
          <div className="bb-sheet__body">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
