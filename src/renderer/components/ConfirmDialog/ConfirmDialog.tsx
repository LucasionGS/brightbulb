import { AlertDialog } from "@base-ui/react/alert-dialog";
import "../Sheet/Sheet.scss";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Asks before a destructive action. Cancel is the default.
 */
export default function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, title, description, confirmLabel, onConfirm, onCancel } = props;
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="bb-sheet__backdrop" />
        <AlertDialog.Popup className="bb-sheet">
          <AlertDialog.Title className="bb-sheet__title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="bb-sheet__description">{description}</AlertDialog.Description>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--bb-space-2)", marginTop: "var(--bb-space-6)" }}>
            <AlertDialog.Close className="bb-btn">Cancel</AlertDialog.Close>
            <button className="bb-btn bb-btn--danger" onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
