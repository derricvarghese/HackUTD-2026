import { useEffect } from 'react';
import { useUi } from '../state/ui';
import { CasePanel } from './CasePanel';

export function CasePopover() {
  const id = useUi((s) => s.openCaseId);
  const close = () => useUi.setState({ openCaseId: null });

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  if (!id) return null;

  return (
    <div className="case-popover-backdrop" onClick={close} role="presentation">
      <div
        className="case-popover-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Case details"
        onClick={(e) => e.stopPropagation()}
      >
        <CasePanel id={id} onClose={close} />
      </div>
    </div>
  );
}
